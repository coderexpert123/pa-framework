"""Unit tests for brain_recheck_scan — the deterministic brain integrity scan.

Run: python -m unittest discover -s projects/pa-maintenance/tests

The counting tests exist because the gemini-workered brain-recheck mis-counted
plans/INDEX.md in all four runs of the 2026-07-16..21 audit window.
"""
import json
import sys
import tempfile
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import brain_recheck_scan as brs  # noqa: E402

TODAY = date(2026, 7, 21)


class TestClassifyStatus(unittest.TestCase):
    def test_completed_variants(self):
        for s in ["Completed", "Completed, deployed — 19 new tests, pa 697/0",
                  "Implemented — 5 commits, 675 tests", "Implemented, deployed",
                  "Resolved, deployed",
                  "Implemented and deep-rechecked against running code 2026-07-04 (6 more)"]:
            self.assertEqual(brs.classify_status(s), "completed", s)

    def test_pending_variants(self):
        for s in ["Approved, pending impl", "Proposed, pending approval",
                  "Pending review", "In progress"]:
            self.assertEqual(brs.classify_status(s), "pending", s)

    def test_pending_is_not_swallowed_by_the_word_impl(self):
        # "Approved, pending impl" must never read as completed just because a
        # later clause mentions implementation.
        self.assertEqual(brs.classify_status("Approved, pending impl"), "pending")

    def test_living_and_superseded(self):
        self.assertEqual(brs.classify_status("Living doc, kept current"), "living")
        self.assertEqual(brs.classify_status("Replaced by V3"), "superseded")

    def test_unknown_is_reported_not_guessed(self):
        self.assertEqual(brs.classify_status("Marinating"), "unknown")
        self.assertEqual(brs.classify_status(""), "unknown")

    def test_completed_variants_with_new_lead_words(self):
        for s in ["Fixed 2026-08-08, deployed",
                  "Restored + verified 2026-08-14",
                  "Remediated + verified; leaked values should be treated as copied",
                  "BOM + procurement + PDF complete; survey still pending",
                  "Built 2026-08-24",
                  "**Phases 2-3 completed 2026-08-14**",
                  "Assessment complete; Wave 1 in deep-plan",
                  "Research complete — no migration planned",
                  "Operator-confirmed 2026-08-15",
                  "Operator-approved 2026-08-15",
                  "Both waves completed 2026-08-02",
                  "All 6 phases completed 2026-08-07"]:
            self.assertEqual(brs.classify_status(s), "completed", s)

    def test_superseded_variants(self):
        for s in ["Superseded / Cancelled (legacy demo script)",
                  "Superseded by SPEC (built 2026-08-24)",
                  "Deprecated"]:
            self.assertEqual(brs.classify_status(s), "superseded", s)


INDEX_FIXTURE = """# Plans Index

| Date | Title | Status | Link |
|------|-------|--------|------|
| 2026-07-20 | AI-098 backoff | Completed, deployed — 19 tests | [Local](./a.md) |
| 2026-06-01 | Old thing (AI-777) | Approved, pending impl | [Local](./b.md) |
| 2026-07-19 | Recent thing | Approved, pending impl | [Local](./missing.md) |
| (living) | Runbook | Living doc, kept current | [Local](./a.md) |
| 2026-05-01 | Dead plan | Replaced by V2 | [View](https://example.com/x) |
"""


class TestIndexParsing(unittest.TestCase):
    def setUp(self):
        self.rows = brs.parse_index_rows(INDEX_FIXTURE)

    def test_header_and_separator_are_not_counted_as_plans(self):
        self.assertEqual(len(self.rows), 5)

    def test_counts_are_exact(self):
        c = brs.index_counts(self.rows)
        self.assertEqual(c, {"total": 5, "completed": 1, "pending": 2,
                             "living": 1, "superseded": 1, "unknown": 0})

    def test_local_links_extracted_http_ignored(self):
        self.assertEqual(brs.local_plan_links(self.rows),
                         ["./a.md", "./b.md", "./missing.md", "./a.md"])

    def test_escaped_pipe_in_title_parses_as_single_cell(self):
        # Line with escaped pipe in title must parse as 4-cell row
        fixture_with_escape = (
            INDEX_FIXTURE +
            "| 2026-08-02 | Framework with `pa maintenance list\\|status\\|run --dry-run` inside | Both waves completed 2026-08-02 (x) | [Local](./a.md) |\n"
        )
        rows = brs.parse_index_rows(fixture_with_escape)
        # Should yield one extra row beyond the 5 in INDEX_FIXTURE
        self.assertEqual(len(rows), 6)
        # The new row's title must contain the UNescaped text
        escaped_row = rows[-1]
        self.assertIn("list|status|run", escaped_row["title"])
        self.assertEqual(escaped_row["status"], "Both waves completed 2026-08-02 (x)")
        # Link extraction must still work
        self.assertEqual(brs.local_plan_links(rows),
                         ["./a.md", "./b.md", "./missing.md", "./a.md", "./a.md"])


class TestExtractRepoPaths(unittest.TestCase):
    def test_only_repo_relative_paths_are_picked_up(self):
        text = ("See `pa/src/workers.ts` and `projects/telegram-bot/src/main.ts`, "
                "but not `logger.ts`, `~/.pa/config.yaml`, `${PA_HOME}`, "
                "`C:/Users/you/.pa`, `C:/notes` or `git status`.")
        self.assertEqual(brs.extract_repo_paths(text),
                         ["pa/src/workers.ts", "projects/telegram-bot/src/main.ts"])

    def test_line_suffix_is_stripped(self):
        self.assertEqual(brs.extract_repo_paths("`pa/src/commands/run.ts:124`"),
                         ["pa/src/commands/run.ts"])

    def test_pytest_node_id_suffix_is_stripped(self):
        self.assertEqual(
            brs.extract_repo_paths("`pa/scripts/tests/test_pii_guard.py::TestX`"),
            ["pa/scripts/tests/test_pii_guard.py"])

    def test_project_relative_scripts_mention_is_not_a_repo_path(self):
        # CLAUDE.md writes `scripts/check_alert_due.py` meaning
        # projects/ekadashi-manager/scripts/… — not a repo-root path.
        self.assertEqual(brs.extract_repo_paths("`scripts/check_alert_due.py`"), [])

    def test_duplicates_collapse(self):
        self.assertEqual(brs.extract_repo_paths("`pa/src/a.ts` and `pa/src/a.ts`"),
                         ["pa/src/a.ts"])

    def test_parent_traversal_is_rejected(self):
        self.assertEqual(brs.extract_repo_paths("`pa/../etc/passwd`"), [])

    def test_bare_list_entry_form_is_extracted(self):
        # inventory/*.md (FILE_INVENTORY.md pre-2026-08-07) writes every entry
        # like this — no backticks. A backtick-only extractor vetted 5 of its
        # ~106 entries and silently skipped the rest, which is the no-op
        # class this whole scan replaces.
        text = ("    -   pa/src/analyzer.ts: Conversation pattern analysis.\n"
                "    -   projects/telegram-bot/src/main.ts: Long-poll loop.\n")
        self.assertEqual(brs.extract_repo_paths(text),
                         ["pa/src/analyzer.ts", "projects/telegram-bot/src/main.ts"])

    def test_list_entry_and_backtick_forms_do_not_double_count(self):
        text = ("-   pa/src/analyzer.ts: Analysis.\n"
                "See also `pa/src/analyzer.ts` for detail.\n")
        self.assertEqual(brs.extract_repo_paths(text), ["pa/src/analyzer.ts"])

    def test_non_path_list_entries_are_ignored(self):
        text = ("-   **Skill Index**: Use pa list to see all skills.\n"
                "-   ~/.pa/google_auth.py: Centralized Google OAuth module.\n"
                "-   scripts/check_alert_due.py: project-relative, not repo-relative.\n")
        self.assertEqual(brs.extract_repo_paths(text), [])


class TestMemoryLinks(unittest.TestCase):
    def test_bare_md_targets_only(self):
        text = ("- [User Profile](user_profile.md) — bio\n"
                "- [Docs](https://example.com/x.md)\n"
                "- [Nested](sub/dir.md)\n")
        self.assertEqual(brs.memory_links(text), ["user_profile.md"])


class TestSkillCounting(unittest.TestCase):
    def test_claim_with_breakdown(self):
        claim = brs.parse_skill_claim(
            "**27 skills total** (21 scheduled, 6 manual, 0 utility).")
        self.assertEqual(claim, {"total": 27, "scheduled": 21, "manual": 6})

    def test_no_claim_returns_none(self):
        self.assertIsNone(brs.parse_skill_claim("nothing to see here"))

    def test_counts_dirs_with_skill_md_and_detects_cron(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "sched").mkdir()
            (root / "sched" / "skill.md").write_text("---\ncron: 0 * * * *\n---\nbody",
                                                     encoding="utf-8")
            (root / "manual").mkdir()
            (root / "manual" / "skill.md").write_text("---\ncwd: x\n---\nbody",
                                                      encoding="utf-8")
            (root / "not-a-skill").mkdir()  # no skill.md
            self.assertEqual(brs.count_skills(root),
                             {"total": 2, "scheduled": 1, "manual": 1})

    def test_missing_dir_is_zero_not_a_crash(self):
        self.assertEqual(brs.count_skills(Path("Z:/nope/skills")),
                         {"total": 0, "scheduled": 0, "manual": 0})


BACKLOG_FIXTURE = """# Backlog

#### [AI-031] Poll Loop Silent Failures
**Type:** Bug | **Priority:** P0 | **Status:** DONE 2026-04-19

*Logged: 2026-04-19. Found during audit.*

#### [AI-777] Old pending thing
**Type:** Feature | **Priority:** P2 | **Status:** PENDING

*Logged: 2026-01-05. Still waiting.*

#### [AI-888] Fresh pending thing
**Type:** Feature | **Priority:** P2 | **Status:** PENDING

*Logged: 2026-07-15.*
"""


class TestBacklogParsing(unittest.TestCase):
    def setUp(self):
        self.items = brs.parse_backlog_items(BACKLOG_FIXTURE)

    def test_all_items_found(self):
        self.assertEqual([i["id"] for i in self.items], ["AI-031", "AI-777", "AI-888"])

    def test_status_and_logged_date(self):
        by_id = {i["id"]: i for i in self.items}
        self.assertEqual(by_id["AI-031"]["status"], "DONE")
        self.assertEqual(by_id["AI-777"]["status"], "PENDING")
        self.assertEqual(by_id["AI-777"]["logged"], "2026-01-05")

    def test_days_since(self):
        self.assertEqual(brs.days_since("2026-07-01", TODAY), 20)
        self.assertIsNone(brs.days_since("not-a-date", TODAY))
        self.assertIsNone(brs.days_since(None, TODAY))


class TestScan(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "repo"
        (self.root / "plans").mkdir(parents=True)
        (self.root / "pa" / "src").mkdir(parents=True)
        (self.root / "pa" / "src" / "workers.ts").write_text("x", encoding="utf-8")
        (self.root / "CLAUDE.md").write_text(
            "See `pa/src/workers.ts` and `pa/src/ghost.ts`.\n"
            "**2 skills total** (1 scheduled, 1 manual, 0 utility).\n",
            encoding="utf-8")
        (self.root / "plans" / "INDEX.md").write_text(INDEX_FIXTURE, encoding="utf-8")
        (self.root / "plans" / "a.md").write_text("a", encoding="utf-8")
        (self.root / "plans" / "b.md").write_text("b", encoding="utf-8")
        (self.root / "BACKLOG.md").write_text(BACKLOG_FIXTURE, encoding="utf-8")

        # inventory/ (post-2026-08-07 FILE_INVENTORY.md split): a router at
        # root + at least one real per-file inventory. pa-core.md carries its
        # OWN broken-link entry (ghost2.ts, distinct from CLAUDE.md's own
        # ghost.ts) so a test can confirm the issue names the inventory
        # sub-file, not a generic "FILE_INVENTORY.md" that no longer holds
        # this content.
        (self.root / "FILE_INVENTORY.md").write_text(
            "Router. See inventory/*.md for per-file entries.\n", encoding="utf-8")
        (self.root / "inventory").mkdir()
        (self.root / "inventory" / "pa-core.md").write_text(
            "    -   pa/src/workers.ts: exists.\n"
            "    -   pa/src/ghost2.ts: does not exist.\n",
            encoding="utf-8")

        # backlog/ (post-2026-08-07 BACKLOG.md dedupe+split): root keeps the
        # open items; a DONE item lives only in an archive file, the same way
        # a real post-split repo splits completed work out of the root file.
        (self.root / "backlog").mkdir()
        (self.root / "backlog" / "archive-test.md").write_text(
            "#### [AI-500] Archived-only item\n"
            "**Type:** Bug | **Priority:** P2 | **Status:** DONE 2026-05-01\n\n"
            "*Logged: 2026-05-01. Lives only in the archive file.*\n",
            encoding="utf-8")

        self.memory = Path(self.tmp.name) / "memory"
        self.memory.mkdir()
        (self.memory / "MEMORY.md").write_text(
            "- [User Profile](user_profile.md)\n- [Gone](gone.md)\n", encoding="utf-8")
        (self.memory / "user_profile.md").write_text("me", encoding="utf-8")

        self.skills = Path(self.tmp.name) / "skills"
        (self.skills / "sched").mkdir(parents=True)
        (self.skills / "sched" / "skill.md").write_text("---\ncron: 0 * * * *\n---\n",
                                                        encoding="utf-8")

    def tearDown(self):
        self.tmp.cleanup()

    def _scan(self):
        return brs.scan(self.root, self.memory, self.skills, TODAY)

    def _kinds(self, result):
        return [i["kind"] for i in result["issues"]]

    def test_index_counts_are_reported(self):
        self.assertEqual(self._scan()["index"]["completed"], 1)
        self.assertEqual(self._scan()["index"]["pending"], 2)

    def test_missing_repo_path_is_a_broken_link(self):
        details = [i["detail"] for i in self._scan()["issues"]]
        self.assertTrue(any("ghost.ts" in d for d in details))
        self.assertFalse(any("workers.ts" in d for d in details))

    def test_inventory_broken_link_names_the_correct_subfile(self):
        # inventory/pa-core.md's own broken-link entry (ghost2.ts) must be
        # attributed to that file, not a generic "FILE_INVENTORY.md" label —
        # the router hasn't held per-file content since the 2026-08-07 split.
        details = [i["detail"] for i in self._scan()["issues"] if "ghost2.ts" in i["detail"]]
        self.assertEqual(len(details), 1)
        self.assertIn("inventory/pa-core.md", details[0])

    def test_empty_inventory_dir_is_a_missing_brain_file(self):
        # Today: FILE_INVENTORY.md itself carried every entry, so an empty
        # file was a real signal. Post-split, the router is deliberately
        # small — the real corpus is inventory/*.md, and if THAT goes empty
        # or absent, every broken-link check below it would silently iterate
        # zero entries and report nothing rather than "couldn't check".
        for f in (self.root / "inventory").glob("*.md"):
            f.unlink()
        result = self._scan()
        missing = [i for i in result["issues"]
                   if i["kind"] == "MISSING BRAIN FILE" and i["detail"] == "inventory/"]
        self.assertEqual(len(missing), 1)
        self.assertEqual(missing[0]["severity"], "critical")

    def test_missing_plan_link_is_a_broken_link(self):
        details = [i["detail"] for i in self._scan()["issues"]]
        self.assertTrue(any("missing.md" in d for d in details))

    def test_missing_memory_file_is_a_broken_link(self):
        details = [i["detail"] for i in self._scan()["issues"]]
        self.assertTrue(any("gone.md" in d for d in details))

    def test_skill_count_mismatch_detected(self):
        # CLAUDE.md claims 2 skills; only 1 exists on disk.
        self.assertIn("COUNT MISMATCH", self._kinds(self._scan()))

    def test_stale_pending_cross_file_contradiction(self):
        # AI-777 is PENDING in the fixture backlog, so no STALE PENDING yet.
        self.assertNotIn("STALE PENDING", self._kinds(self._scan()))
        (self.root / "BACKLOG.md").write_text(
            BACKLOG_FIXTURE.replace("**Status:** PENDING\n\n*Logged: 2026-01-05",
                                    "**Status:** DONE 2026-06-01\n\n*Logged: 2026-01-05"),
            encoding="utf-8")
        self.assertIn("STALE PENDING", self._kinds(self._scan()))

    def test_overdue_plan_uses_the_21_day_threshold(self):
        overdue = [i for i in self._scan()["issues"] if i["kind"] == "OVERDUE PLAN"]
        # 2026-06-01 row is 50 days old; the 2026-07-19 row is 2 days old.
        self.assertEqual(len(overdue), 1)
        self.assertIn("Old thing", overdue[0]["detail"])

    def test_aged_backlog_uses_the_30_day_threshold(self):
        aged = [i for i in self._scan()["issues"] if i["kind"] == "AGED BACKLOG ITEM"]
        self.assertEqual([("AI-777" in a["detail"]) for a in aged], [True])

    def test_backlog_archive_file_is_read_alongside_root(self):
        # AI-500 lives ONLY in backlog/archive-test.md (see setUp) — the scan
        # must read root BACKLOG.md + backlog/*.md together, the same way
        # STALE PENDING already needs to see a DONE id regardless of which
        # file it's archived in.
        result = self._scan()
        self.assertEqual(result["backlog"]["done"], 2)  # AI-031 (root) + AI-500 (archive)
        self.assertEqual(result["backlog"]["total"], 4)  # + AI-777, AI-888

    def test_stale_pending_fires_against_an_archived_done_id(self):
        (self.root / "plans" / "INDEX.md").write_text(
            INDEX_FIXTURE + "| 2026-07-18 | References AI-500 | Approved, pending impl | [Local](./a.md) |\n",
            encoding="utf-8")
        self.assertIn("STALE PENDING", self._kinds(self._scan()))

    def test_summary_severity_tally_matches_issue_list(self):
        result = self._scan()
        self.assertEqual(result["summary"]["issues"], len(result["issues"]))
        self.assertEqual(
            result["summary"]["critical"] + result["summary"]["warnings"]
            + result["summary"]["info"],
            len(result["issues"]))

    def test_output_is_valid_json(self):
        self.assertIsInstance(json.loads(json.dumps(self._scan())), dict)


class TestDefaultMemoryDir(unittest.TestCase):
    def test_windows_repo_path_is_slugified(self):
        slug = brs.default_memory_dir(Path("C:/pa-checkout")).parent.name
        self.assertEqual(slug, "C--pa-checkout")


class TestBrokenRunbookReferences(unittest.TestCase):
    """WPD6: Test broken runbook reference detection in postmortems."""

    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.repo_root = Path(self.temp_dir.name)
        (self.repo_root / "plans").mkdir()
        (self.repo_root / "plans" / "postmortems").mkdir()
        (self.repo_root / "plans" / "runbooks").mkdir()

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_broken_runbook_reference_is_detected(self):
        # Create a postmortem with a broken runbook reference
        pm_file = self.repo_root / "plans" / "postmortems" / "2026-08-17-test.md"
        pm_file.write_text(
            "# Test Postmortem\n\n"
            "See [Runbook: bot-down](../runbooks/bot-down.md) for details.\n",
            encoding="utf-8",
        )

        # Don't create the referenced runbook
        result = brs.scan(self.repo_root, Path(self.temp_dir.name) / "memory", Path(), TODAY)

        broken_refs = [i for i in result["issues"] if i["kind"] == "BROKEN RUNBOOK REF"]
        self.assertEqual(len(broken_refs), 1)
        self.assertIn("bot-down.md", broken_refs[0]["detail"])

    def test_valid_runbook_reference_is_not_flagged(self):
        # Create a postmortem with a valid runbook reference
        pm_file = self.repo_root / "plans" / "postmortems" / "2026-08-17-test.md"
        pm_file.write_text(
            "# Test Postmortem\n\n"
            "See [Runbook: bot-down](../runbooks/bot-down.md) for details.\n",
            encoding="utf-8",
        )

        # Create the referenced runbook
        rb_file = self.repo_root / "plans" / "runbooks" / "bot-down.md"
        rb_file.write_text("# Bot Down Runbook\n", encoding="utf-8")

        result = brs.scan(self.repo_root, Path(self.temp_dir.name) / "memory", Path(), TODAY)

        broken_refs = [i for i in result["issues"] if i["kind"] == "BROKEN RUNBOOK REF"]
        self.assertEqual(len(broken_refs), 0)

    def test_http_links_are_not_checked_as_runbooks(self):
        # HTTP links should not be checked as runbook references
        pm_file = self.repo_root / "plans" / "postmortems" / "2026-08-17-test.md"
        pm_file.write_text(
            "# Test Postmortem\n\n"
            "See [External Doc](https://example.com/doc) for details.\n",
            encoding="utf-8",
        )

        result = brs.scan(self.repo_root, Path(self.temp_dir.name) / "memory", Path(), TODAY)

        broken_refs = [i for i in result["issues"] if i["kind"] == "BROKEN RUNBOOK REF"]
        self.assertEqual(len(broken_refs), 0)


if __name__ == "__main__":
    unittest.main()
