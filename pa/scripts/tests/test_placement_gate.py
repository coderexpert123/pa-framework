"""Unit tests for pa/scripts/placement_gate.py (placement Phase-3 WP-1).

All fixtures are INLINE synthetic registry strings — no real feature names, no
operator paths. Git-backed cases build a throwaway `git init` repo under a
tempfile.mkdtemp tmpdir and drive the real gate entry points (main / derive / gen).
The 12-cell fixture header mirrors the census-table grammar shared with
scratch/placement-audit/check_completeness.py.
"""
import contextlib
import hashlib
import importlib.util
import io
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from datetime import datetime, timezone

_MODULE_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "placement_gate.py",
)
_spec = importlib.util.spec_from_file_location("placement_gate", _MODULE_PATH)
placement_gate = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(placement_gate)

HEADER = ("| feature | surfaces | boundary | verdict | split-line | tier | rationale "
          "| evidence | gen-owed | confidence | provenance | status |")
SEP = "|" + "---|" * 12


def census_table(census_id, rows, extra_tail=None):
    lines = ["## Fixture census (%s)" % census_id, "", HEADER, SEP]
    lines.extend(rows)
    if extra_tail:
        lines.extend(extra_tail)
    return lines


def row(feature, surfaces, boundary, verdict, split="-"):
    return ("| %s | %s | %s | %s | %s | framework-core | r | e | none | clear | "
            "fixture-prov | active |"
            % (feature, surfaces, boundary, verdict, split))


class GateTestBase(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pa-placement-gate-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        # The throwaway mirror repo is a SUBDIR so registry/projection/flags files in
        # self.tmp never appear as its untracked candidates.
        self.repo = os.path.join(self.tmp, "mirror")
        os.makedirs(self.repo)

    def write(self, rel, text):
        path = os.path.join(self.tmp, rel)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        return path

    def write_repo_file(self, rel, text="content\n"):
        path = os.path.join(self.repo, rel.replace("/", os.sep))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        return path

    def registry_text(self, census_id, rows, extra_tail=None):
        return "\n".join(census_table(census_id, rows, extra_tail)) + "\n"

    def two_table_registry(self, census_a, rows_a, census_b, rows_b):
        """A registry carrying two census sections (e.g. N1 projection rows + an N3
        boundary-lines table) — the shape gen --gitignore fixtures need."""
        lines = census_table(census_a, rows_a) + [""] + census_table(census_b, rows_b)
        return "\n".join(lines) + "\n"

    def n3_only_registry(self, n3_rows):
        """An N3 table whose rows carry PRIVATE + prose surfaces, so the boundary
        cells are exercised without projection noise (nothing allows, nothing
        denies, nothing is assumed)."""
        return self.registry_text("N3", [
            row(f, "fixture prose surface", "private-excluded", "PRIVATE")
            for f in n3_rows])

    def run_gate(self, argv):
        out, err = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            rc = placement_gate.main(argv)
        return rc, out.getvalue(), err.getvalue()

    def gen_projection(self, registry_path):
        out_path = os.path.join(self.tmp, "projection.json")
        rc, out, err = self.run_gate(
            ["gen", "--registry", registry_path, "--out", out_path])
        self.assertEqual(rc, 0, out + err)
        return out_path

    def git(self, *args):
        kwargs = {}
        if os.name == "nt":
            kwargs["creationflags"] = 0x08000000
        subprocess.run(["git", "-C", self.repo] + list(args), check=True,
                       capture_output=True, text=True, **kwargs)

    def init_repo(self):
        self.git("init")
        self.git("config", "user.email", "gate-test@example.invalid")
        self.git("config", "user.name", "gate-test")


class ParseTests(GateTestBase):
    def test_parse_registry_rows(self):
        # happy 12-cell row, separator skipped, prose + prose heading ignored.
        lines = census_table("N1", [
            row("alpha-skill", "pkg/alpha.md", "public-tracked", "PUBLIC"),
        ], extra_tail=["", "Free narrative prose between tables.", "",
                       "## A prose heading with no census token"])
        parsed = placement_gate.parse_registry_rows(lines)
        self.assertEqual(len(parsed), 1)
        r = parsed[0]
        self.assertEqual(r.feature, "alpha-skill")
        self.assertEqual(r.census, "N1")
        self.assertEqual(r.boundary, "public-tracked")
        self.assertEqual(r.verdict, "PUBLIC")
        self.assertEqual(r.surfaces_raw, "pkg/alpha.md")
        self.assertEqual(r.lineno, 5)
        # wrong cell count raises (an unescaped '|' in a cell yields the same shape).
        bad = census_table("N1", [
            "| too-few | pkg/x.md | public-tracked | PUBLIC | - | core | r | e | none "
            "| clear | prov |",
        ])
        with self.assertRaises(placement_gate.RegistryParseError):
            placement_gate.parse_registry_rows(bad)
        bad_pipe = census_table("N1", [
            row("pipe|extra-cell", "pkg/x.md", "public-tracked", "PUBLIC"),
        ])
        with self.assertRaises(placement_gate.RegistryParseError):
            placement_gate.parse_registry_rows(bad_pipe)


class DeriveTests(GateTestBase):
    def test_derive_r1_public_surfaces(self):
        rows = placement_gate.parse_registry_rows(census_table("N1", [
            row("pub-thing", "src/one.py; src/lib/; src/gen/*.py",
                "public-tracked", "PUBLIC"),
        ]))
        proj = placement_gate.derive(rows)
        self.assertEqual(proj.deny, [])
        self.assertEqual([e["glob"] for e in proj.allow],
                         ["src/one.py", "src/lib/", "src/gen/*.py"])
        self.assertTrue(all(e["assumed"] is False for e in proj.allow))
        self.assertEqual({e["verdict"] for e in proj.allow}, {"PUBLIC"})
        self.assertEqual(proj.assumed, 0)
        self.assertEqual(proj.warnings, [])

    def test_derive_r2_split_public_tracked(self):
        rows = placement_gate.parse_registry_rows(census_table("N1", [
            row("split-thing", "pkg/mod.py", "public-tracked", "SPLIT",
                split="public half tracked; runtime half private"),
        ]))
        proj = placement_gate.derive(rows)
        self.assertEqual(proj.allow, [{"feature": "split-thing", "census": "N1",
                                       "verdict": "SPLIT", "glob": "pkg/mod.py",
                                       "assumed": False}])
        self.assertEqual(proj.warnings, [])

    def test_derive_r3_split_coverage(self):
        rows = placement_gate.parse_registry_rows(census_table("N1", [
            row("split-a", "feat/covered_by_pub.py;feat/covered_by_priv.py;"
                "feat/orphan.ts", "mixed", "SPLIT"),
            row("pub-row", "feat/covered_by_pub.py", "public-tracked", "PUBLIC"),
            row("priv-row", "feat/covered_by_priv.py", "private-excluded", "PRIVATE"),
        ]))
        proj = placement_gate.derive(rows)
        globs = [e["glob"] for e in proj.allow]
        # covered by the PUBLIC row -> emitted from that row, not the SPLIT row
        self.assertIn("feat/covered_by_pub.py", globs)
        # covered by the exact-file PRIVATE row -> suppressed, and denied
        self.assertNotIn("feat/covered_by_priv.py", globs)
        self.assertEqual([e["glob"] for e in proj.deny], ["feat/covered_by_priv.py"])
        # uncovered surface -> assumed public with the loud warning
        orphan = next(e for e in proj.allow if e["glob"] == "feat/orphan.ts")
        self.assertEqual(orphan["feature"], "split-a")
        self.assertTrue(orphan["assumed"])
        self.assertEqual(proj.warnings, ["SPLIT-ASSUMED-PUBLIC: split-a feat/orphan.ts"])
        # the warning reaches stderr through the real gen entry point
        reg = self.write("registry.md", self.registry_text("N1", [
            row("split-a", "feat/orphan.ts", "mixed", "SPLIT"),
        ]))
        _rc, _out, err = self.run_gate(
            ["gen", "--registry", reg, "--out", os.path.join(self.tmp, "p.json")])
        self.assertIn("SPLIT-ASSUMED-PUBLIC: split-a feat/orphan.ts", err)

    def test_derive_prose_surfaces(self):
        # PRIVATE row: prose surface skipped silently, path surface still denied.
        rows = placement_gate.parse_registry_rows(census_table("N1", [
            row("priv-prose", "repo root all top-level entries;pkg/priv.py",
                "private-excluded", "PRIVATE"),
        ]))
        proj = placement_gate.derive(rows)
        self.assertEqual(proj.allow, [])
        self.assertEqual([e["glob"] for e in proj.deny], ["pkg/priv.py"])
        self.assertEqual(proj.warnings, [])
        # PUBLIC row: prose surface is a hard generator error.
        rows_bad = placement_gate.parse_registry_rows(census_table("N1", [
            row("pub-prose", "all top level entries", "public-tracked", "PUBLIC"),
        ]))
        with self.assertRaises(placement_gate.PlacementGateError):
            placement_gate.derive(rows_bad)

    def test_derive_runtime_surfaces_dropped(self):
        rows = placement_gate.parse_registry_rows(census_table("N1", [
            row("pub-mixed", "~/runtime/thing.md;pkg/pub.py", "public-tracked", "PUBLIC"),
            row("priv-mixed", "~/runtime/other.md;pkg/priv.py",
                "private-excluded", "PRIVATE"),
        ]))
        proj = placement_gate.derive(rows)
        self.assertEqual([e["glob"] for e in proj.allow], ["pkg/pub.py"])
        self.assertEqual([e["glob"] for e in proj.deny], ["pkg/priv.py"])

    def test_derive_deny_rules(self):
        rows = placement_gate.parse_registry_rows(census_table("N1", [
            row("priv-exact", "pkg/secret.py", "private-excluded", "PRIVATE"),
        ]))
        proj = placement_gate.derive(rows)
        self.assertEqual(proj.allow, [])
        self.assertEqual([e["glob"] for e in proj.deny], ["pkg/secret.py"])

    def test_derive_private_dir_glob_surface_refused(self):
        # A PRIVATE row's surface must be exact-file: a directory or glob surface
        # can never produce a DENY, so authoring one is refused at parse time
        # instead of silently accepted as a no-op the table would otherwise present
        # as an enforced exclusion. Proves the check can FAIL on each malformed
        # shape (trailing-slash dir, no-dot dir, and glob) before proving it clears.
        for feature, surface in (
            ("priv-dir", "pkg/dir/"),
            ("priv-dir-nodot", "pkg/otherdir"),
            ("priv-glob", "pkg/*.md"),
        ):
            rows = placement_gate.parse_registry_rows(census_table("N1", [
                row(feature, surface, "private-excluded", "PRIVATE"),
            ]))
            with self.assertRaises(placement_gate.PlacementGateError) as ctx:
                placement_gate.derive(rows)
            msg = str(ctx.exception)
            self.assertIn(feature, msg)
            self.assertIn(surface, msg)
            self.assertIn("directory- or glob-grained", msg)
        # Same fixture, rewritten with an exact-file surface -> derives cleanly.
        rows_fixed = placement_gate.parse_registry_rows(census_table("N1", [
            row("priv-dir-fixed", "pkg/dir/file.py", "private-excluded", "PRIVATE"),
        ]))
        proj = placement_gate.derive(rows_fixed)
        self.assertEqual(proj.allow, [])
        self.assertEqual([e["glob"] for e in proj.deny], ["pkg/dir/file.py"])


class GenTests(GateTestBase):
    def test_gen_writes_projection(self):
        reg = self.write("registry.md", self.registry_text("N1", [
            row("pub-a", "pkg/pub.py;pkg/dir/", "public-tracked", "PUBLIC"),
            row("priv-a", "pkg/secret.py", "private-excluded", "PRIVATE"),
        ]))
        out_path = os.path.join(self.tmp, "nested", "projection.json")
        rc, out, err = self.run_gate(
            ["gen", "--registry", reg, "--out", out_path])
        self.assertEqual(rc, 0)
        self.assertEqual(err, "")
        self.assertEqual(out, "PLACEMENT-PROJECTION OK rows=2 allow=2 deny=1 "
                              "assumed=0 -> %s\n" % out_path)
        with open(out_path, encoding="utf-8") as fh:
            payload = json.load(fh)
        self.assertEqual(list(payload.keys()),
                         ["version", "generated_at", "registry", "registry_sha256",
                          "counts", "allow", "deny"])
        self.assertEqual(payload["version"], 1)
        self.assertEqual(payload["registry"], reg)
        with open(reg, "rb") as fh:
            reg_sha = hashlib.sha256(fh.read()).hexdigest()
        self.assertEqual(payload["registry_sha256"], reg_sha)
        self.assertEqual(payload["counts"],
                         {"rows": 2, "allow": 2, "deny": 1, "assumed": 0})
        self.assertEqual(list(payload["allow"][0].keys()),
                         ["feature", "census", "verdict", "glob", "assumed"])
        self.assertEqual(list(payload["deny"][0].keys()),
                         ["feature", "census", "glob"])
        self.assertRegex(payload["generated_at"],
                         r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertFalse(os.path.exists(out_path + ".tmp"))  # atomic: no stray tmp


class CheckTests(GateTestBase):
    def check_run(self, registry_path, flags_path):
        proj = self.gen_projection(registry_path)
        return self.run_gate(["check", "--registry", registry_path,
                              "--projection", proj, "--public-repo", self.repo,
                              "--flags-file", flags_path])

    def test_check_ok_new_allowed_file(self):
        reg = self.write("registry.md", self.registry_text("N1", [
            row("pub-a", "pkg/", "public-tracked", "PUBLIC"),
        ]))
        self.init_repo()
        self.write_repo_file("pkg/pub.py")
        flags = os.path.join(self.tmp, "flags.jsonl")
        rc, out, err = self.check_run(reg, flags)
        self.assertEqual(rc, 0, out + err)
        self.assertEqual(out.splitlines()[-1], "PLACEMENT-GATE OK new=1")
        self.assertFalse(os.path.exists(flags))

    def test_check_refuse_and_flag_record(self):
        reg = self.write("registry.md", self.registry_text("N1", [
            row("pub-a", "pkg/", "public-tracked", "PUBLIC"),
        ]))
        self.init_repo()
        self.write_repo_file("other/unknown.bin")
        flags = os.path.join(self.tmp, "flags.jsonl")
        rc, out, err = self.check_run(reg, flags)
        self.assertEqual(rc, 2)
        lines = out.splitlines()
        self.assertIn("PLACEMENT-UNKNOWN: other/unknown.bin", lines)
        self.assertEqual(lines[-1], "PLACEMENT-GATE REFUSED files=1")
        with open(flags, encoding="utf-8") as fh:
            flag_lines = [ln for ln in fh.read().splitlines() if ln.strip()]
        self.assertEqual(len(flag_lines), 1)
        rec = json.loads(flag_lines[0])
        self.assertEqual(list(rec.keys()),
                         ["timestamp", "file", "reason", "category", "run"])
        self.assertRegex(rec["timestamp"], r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$")
        self.assertEqual(rec["file"], "other/unknown.bin")
        self.assertEqual(rec["reason"],
                         "new-to-mirror file matches no public-eligible "
                         "placement-registry row")
        self.assertEqual(rec["category"], "placement-unknown")
        self.assertEqual(rec["run"], "push-public")
        # byte-exact join-key stability: <timestamp>::<file> survives a re-dump.
        key = "%s::%s" % (rec["timestamp"], rec["file"])
        redumped = json.loads(json.dumps(rec))
        self.assertEqual("%s::%s" % (redumped["timestamp"], redumped["file"]), key)

    def test_check_deny_overrides_allow(self):
        reg = self.write("registry.md", self.registry_text("N1", [
            row("pub-a", "pkg/", "public-tracked", "PUBLIC"),
            row("priv-a", "pkg/secret.py", "private-excluded", "PRIVATE"),
        ]))
        self.init_repo()
        self.write_repo_file("pkg/secret.py")
        flags = os.path.join(self.tmp, "flags.jsonl")
        rc, out, err = self.check_run(reg, flags)
        self.assertEqual(rc, 2)
        lines = out.splitlines()
        self.assertIn("PLACEMENT-UNKNOWN: pkg/secret.py", lines)
        self.assertEqual(lines[-1], "PLACEMENT-GATE REFUSED files=1")
        self.assertIn("PLACEMENT-DENY: pkg/secret.py matched deny glob pkg/secret.py",
                      err)

    def test_check_flag_dedupe(self):
        reg = self.write("registry.md", self.registry_text("N1", [
            row("pub-a", "pkg/", "public-tracked", "PUBLIC"),
        ]))
        self.init_repo()
        self.write_repo_file("other/unknown.bin")
        flags = os.path.join(self.tmp, "flags.jsonl")
        rc, out, err = self.check_run(reg, flags)
        self.assertEqual(rc, 2)
        rc2, out2, err2 = self.check_run(reg, flags)
        self.assertEqual(rc2, 2)
        self.assertIn("PLACEMENT-FLAG-EXISTS: other/unknown.bin", out2.splitlines())
        with open(flags, encoding="utf-8") as fh:
            flag_lines = [ln for ln in fh.read().splitlines() if ln.strip()]
        self.assertEqual(len(flag_lines), 1)  # no second flag line

    def test_check_stale_projection(self):
        reg = self.write("registry.md", self.registry_text("N1", [
            row("pub-a", "pkg/", "public-tracked", "PUBLIC"),
        ]))
        proj = self.gen_projection(reg)
        with open(reg, "a", encoding="utf-8", newline="\n") as fh:
            fh.write("<!-- registry mutated after gen -->\n")
        flags = os.path.join(self.tmp, "flags.jsonl")
        rc, out, err = self.run_gate(["check", "--registry", reg,
                                      "--projection", proj,
                                      "--public-repo", self.repo,
                                      "--flags-file", flags])
        self.assertEqual(rc, 3)
        self.assertEqual(out, "PLACEMENT-GATE STALE projection=%s registry sha "
                              "mismatch — regenerate\n" % proj)

    def test_check_tracked_files_not_candidates(self):
        reg = self.write("registry.md", self.registry_text("N1", [
            row("pub-a", "pkg/", "public-tracked", "PUBLIC"),
        ]))
        self.init_repo()
        self.write_repo_file("pkg/pub.py")
        self.git("add", "pkg/pub.py")
        self.git("commit", "-m", "fixture commit")
        flags = os.path.join(self.tmp, "flags.jsonl")
        rc, out, err = self.check_run(reg, flags)
        self.assertEqual(rc, 0, out + err)
        self.assertEqual(out.splitlines()[-1], "PLACEMENT-GATE OK new=0")


class TimestampTests(GateTestBase):
    def test_utc_z_fixed_clock(self):
        fixed = datetime(2026, 9, 4, 12, 0, 0, tzinfo=timezone.utc)
        self.assertEqual(placement_gate.utc_z(fixed), "2026-09-04T12:00:00Z")


class EmitTests(GateTestBase):
    def test_emit_lines_project_n3_features(self):
        # Boundary cells are projected VERBATIM, in registry order, under the fixed
        # header; no transformation, no dedupe.
        self.init_repo()
        reg = self.write("registry.md", self.n3_only_registry([
            "L4:/*",
            "L7:!/.gitignore",
            "L8:!/.gitignore-public",
            "L9:pkg/dir/",
            "L10:pkg/*.log",
        ]))
        gi = os.path.join(self.tmp, "boundary.gitignore")
        out_path = os.path.join(self.tmp, "projection.json")
        rc, out, err = self.run_gate(
            ["gen", "--registry", reg, "--out", out_path,
             "--gitignore", gi, "--scan-repo", self.repo])
        self.assertEqual(rc, 0, out + err)
        self.assertEqual(err, "")
        self.assertEqual(out.splitlines(), [
            "PLACEMENT-PROJECTION OK rows=5 allow=0 deny=0 assumed=0 -> %s" % out_path,
            "PLACEMENT-BOUNDARY OK lines=5 -> %s" % gi,
        ])
        with open(gi, "r", encoding="utf-8", newline="") as fh:
            written = fh.read()
        self.assertEqual(written, "\n".join([
            "# pa-framework public boundary - GENERATED file; do not edit by hand.",
            "# Source of truth: the placement registry's Boundary lines (N3) section; "
            "regenerate with pa/scripts/placement_gate.py gen --gitignore.",
            "",
            "/*",
            "!/.gitignore",
            "!/.gitignore-public",
            "pkg/dir/",
            "pkg/*.log",
        ]) + "\n")
        self.assertFalse(os.path.exists(gi + ".tmp"))
        self.assertFalse(os.path.exists(out_path + ".tmp"))  # atomic: no stray tmp

    def test_emit_rejects_non_l_keyed_boundary_row(self):
        reg = self.write("registry.md", self.n3_only_registry(["boundary-line"]))
        gi = os.path.join(self.tmp, "boundary.gitignore")
        rc, out, err = self.run_gate(
            ["gen", "--registry", reg, "--out", os.path.join(self.tmp, "p.json"),
             "--gitignore", gi, "--scan-repo", self.repo])
        self.assertEqual(rc, 4)
        self.assertIn("not keyed L<lineno>", err)
        self.assertFalse(os.path.exists(gi))

    def test_emit_refuses_assumed_surfaces(self):
        # An uncovered SPLIT surface can never reach the generated boundary.
        reg = self.write("registry.md", self.registry_text("N1", [
            row("split-a", "feat/orphan.ts", "mixed", "SPLIT"),
        ]))
        gi = os.path.join(self.tmp, "boundary.gitignore")
        rc, out, err = self.run_gate(
            ["gen", "--registry", reg, "--out", os.path.join(self.tmp, "p.json"),
             "--gitignore", gi, "--scan-repo", self.repo])
        self.assertEqual(rc, 4)
        self.assertIn("PLACEMENT-BOUNDARY-ASSUMED: split-a feat/orphan.ts", err)
        self.assertIn("PLACEMENT-BOUNDARY REFUSED assumed=1 — every boundary line "
                      "must have an owning registry row", err)
        self.assertFalse(os.path.exists(gi))

    def test_emit_requires_self_reinclude(self):
        reg = self.write("registry.md", self.n3_only_registry([
            "L4:/*",
            "L7:!/.gitignore",
        ]))
        gi = os.path.join(self.tmp, "boundary.gitignore")
        rc, out, err = self.run_gate(
            ["gen", "--registry", reg, "--out", os.path.join(self.tmp, "p.json"),
             "--gitignore", gi, "--scan-repo", self.repo])
        self.assertEqual(rc, 4)
        self.assertIn("SELF-REINCLUDE", err)
        self.assertFalse(os.path.exists(gi))

    def test_gen_gitignore_validates_projection(self):
        self.init_repo()
        self.write_repo_file("pkg/pub.py")
        self.write_repo_file("pkg/secret.py")
        self.git("add", ".")
        self.git("commit", "-m", "fixture")
        # The boundary re-includes pkg/ wholesale, so the projection's PUBLIC row
        # must carry the pkg/ dir surface for the directory-prefix probe to classify
        # expected-public under the uniform rule.
        reg = self.write("registry.md", self.two_table_registry(
            "N1", [
                row("pub-a", "pkg/pub.py;pkg/", "public-tracked", "PUBLIC"),
                row("priv-a", "pkg/secret.py", "private-excluded", "PRIVATE"),
            ],
            "N3", [
                row("L7:!pkg/", "the package carve-out", "private-excluded", "PRIVATE"),
                row("L8:pkg/secret.py", "the private file", "private-excluded",
                    "PRIVATE"),
                row("L9:!/.gitignore-public", "self re-include", "private-excluded",
                    "PRIVATE"),
            ]))
        gi = os.path.join(self.tmp, "boundary.gitignore")
        out_path = os.path.join(self.tmp, "projection.json")
        rc, out, err = self.run_gate(
            ["gen", "--registry", reg, "--out", out_path,
             "--gitignore", gi, "--scan-repo", self.repo])
        self.assertEqual(rc, 0, out + err)
        self.assertEqual(err, "")
        self.assertEqual(out.splitlines(), [
            "PLACEMENT-PROJECTION OK rows=5 allow=2 deny=1 assumed=0 -> %s" % out_path,
            "PLACEMENT-BOUNDARY OK lines=3 -> %s" % gi,
        ])
        with open(gi, "r", encoding="utf-8", newline="") as fh:
            self.assertEqual([ln for ln in fh.read().splitlines()[3:]],
                             ["!pkg/", "pkg/secret.py", "!/.gitignore-public"])

    def test_gen_gitignore_flags_allow_denied(self):
        self.init_repo()
        self.write_repo_file("pkg/pub.py")
        self.write_repo_file("pkg/secret.py")
        self.git("add", ".")
        self.git("commit", "-m", "fixture")
        reg = self.write("registry.md", self.two_table_registry(
            "N1", [
                row("pub-a", "pkg/pub.py;pkg/", "public-tracked", "PUBLIC"),
                row("priv-a", "pkg/secret.py", "private-excluded", "PRIVATE"),
            ],
            "N3", [
                row("L7:!pkg/", "the package carve-out", "private-excluded", "PRIVATE"),
                row("L8:pkg/pub.py", "deny covers the public file", "private-excluded",
                    "PRIVATE"),
                row("L9:!/.gitignore-public", "self re-include", "private-excluded",
                    "PRIVATE"),
            ]))
        gi = os.path.join(self.tmp, "boundary.gitignore")
        rc, out, err = self.run_gate(
            ["gen", "--registry", reg, "--out", os.path.join(self.tmp, "p.json"),
             "--gitignore", gi, "--scan-repo", self.repo])
        self.assertEqual(rc, 4)
        self.assertIn("PLACEMENT-BOUNDARY-MISMATCH: ALLOW-DENIED pkg/pub.py", err)
        self.assertFalse(os.path.exists(gi))

    def test_gen_gitignore_flags_deny_public(self):
        self.init_repo()
        self.write_repo_file("pkg/secret.py")
        self.git("add", ".")
        self.git("commit", "-m", "fixture")
        reg = self.write("registry.md", self.two_table_registry(
            "N1", [
                row("priv-a", "pkg/secret.py", "private-excluded", "PRIVATE"),
            ],
            "N3", [
                row("L7:!pkg/", "the package carve-out", "private-excluded", "PRIVATE"),
                row("L9:!/.gitignore-public", "self re-include", "private-excluded",
                    "PRIVATE"),
            ]))
        gi = os.path.join(self.tmp, "boundary.gitignore")
        rc, out, err = self.run_gate(
            ["gen", "--registry", reg, "--out", os.path.join(self.tmp, "p.json"),
             "--gitignore", gi, "--scan-repo", self.repo])
        self.assertEqual(rc, 4)
        self.assertIn("PLACEMENT-BOUNDARY-MISMATCH: DENY-PUBLIC pkg/secret.py", err)
        self.assertFalse(os.path.exists(gi))

    def test_gen_gitignore_carve_out_denial_warns_not_fails(self):
        # 2026-09-05 adjudication: a boundary denial of a path allowed ONLY by
        # directory-grained rows is a legitimate carve-out — stderr warning with the
        # example line and the count, exit 0, boundary WRITTEN.
        self.init_repo()
        self.write_repo_file("pkg/pub.py")
        self.write_repo_file("pkg/secret.py")
        self.git("add", ".")
        self.git("commit", "-m", "fixture")
        reg = self.write("registry.md", self.two_table_registry(
            "N1", [
                row("pub-a", "pkg/", "public-tracked", "PUBLIC"),
            ],
            "N3", [
                row("L7:!pkg/", "the package carve-out", "private-excluded",
                    "PRIVATE"),
                row("L8:pkg/secret.py", "carve-out denies one child",
                    "private-excluded", "PRIVATE"),
                row("L9:!/.gitignore-public", "self re-include", "private-excluded",
                    "PRIVATE"),
            ]))
        gi = os.path.join(self.tmp, "boundary.gitignore")
        out_path = os.path.join(self.tmp, "p.json")
        rc, out, err = self.run_gate(
            ["gen", "--registry", reg, "--out", out_path,
             "--gitignore", gi, "--scan-repo", self.repo])
        self.assertEqual(rc, 0, out + err)
        self.assertEqual(out.splitlines(), [
            "PLACEMENT-PROJECTION OK rows=4 allow=1 deny=0 assumed=0 -> %s" % out_path,
            "PLACEMENT-BOUNDARY OK lines=3 -> %s" % gi,
        ])
        self.assertIn("PLACEMENT-BOUNDARY-CARVE-OUT: pkg/secret.py", err)
        self.assertIn("PLACEMENT-BOUNDARY-WARNING: 1 allowed-path denial(s) are "
                      "directory-grained carve-outs", err)
        self.assertNotIn("PLACEMENT-BOUNDARY-MISMATCH", err)
        with open(gi, "r", encoding="utf-8", newline="") as fh:
            self.assertEqual([ln for ln in fh.read().splitlines()[3:]],
                             ["!pkg/", "pkg/secret.py", "!/.gitignore-public"])

    def test_gen_gitignore_glob_allow_carve_out_also_warns(self):
        # The carve-out grain test is on the ALLOWING row: a glob surface counts as
        # directory-grained exactly like a dir surface does (the boundary denies a
        # second glob-covered file while re-including the first).
        self.init_repo()
        self.write_repo_file("pkg/one.pub.md")
        self.write_repo_file("pkg/two.pub.md")
        self.git("add", ".")
        self.git("commit", "-m", "fixture")
        reg = self.write("registry.md", self.two_table_registry(
            "N1", [
                row("pub-a", "pkg/*.pub.md", "public-tracked", "PUBLIC"),
            ],
            "N3", [
                row("L7:pkg/*", "children-level base deny (a directory-grained base "
                    "could never be re-included under)", "private-excluded", "PRIVATE"),
                row("L8:!pkg/one.pub.md", "single carve-out", "private-excluded",
                    "PRIVATE"),
                row("L9:!/.gitignore-public", "self re-include", "private-excluded",
                    "PRIVATE"),
            ]))
        gi = os.path.join(self.tmp, "boundary.gitignore")
        out_path = os.path.join(self.tmp, "p.json")
        rc, out, err = self.run_gate(
            ["gen", "--registry", reg, "--out", out_path,
             "--gitignore", gi, "--scan-repo", self.repo])
        self.assertEqual(rc, 0, out + err)
        self.assertIn("PLACEMENT-BOUNDARY-CARVE-OUT: pkg/two.pub.md", err)
        self.assertIn("PLACEMENT-BOUNDARY-WARNING: 1 allowed-path denial(s) are "
                      "directory-grained carve-outs", err)
        self.assertNotIn("PLACEMENT-BOUNDARY-MISMATCH", err)
        self.assertTrue(os.path.exists(gi))


class CompareTests(GateTestBase):
    def emit_boundary(self, reg, gi):
        self.init_repo()
        rc, out, err = self.run_gate(
            ["gen", "--registry", reg, "--out", os.path.join(self.tmp, "p.json"),
             "--gitignore", gi, "--scan-repo", self.repo])
        self.assertEqual(rc, 0, out + err)

    def test_compare_steady_state_ok(self):
        reg = self.write("registry.md", self.n3_only_registry([
            "L4:/*",
            "L7:!/.gitignore",
            "L8:!/.gitignore-public",
            "L9:pkg/dir/",
            "L10:pkg/*.log",
        ]))
        gi = os.path.join(self.tmp, "boundary.gitignore")
        self.emit_boundary(reg, gi)
        rc, out, err = self.run_gate(
            ["compare", "--registry", reg, "--generated", gi,
             "--scan-repo", self.repo])
        self.assertEqual(rc, 0, out + err)
        self.assertEqual(
            out, "PLACEMENT-BOUNDARY VERIFIED generated=%s matches registry "
                 "derivation\n" % gi)

    def test_compare_drift_detected(self):
        reg = self.write("registry.md", self.n3_only_registry([
            "L4:/*",
            "L7:!/.gitignore",
            "L8:!/.gitignore-public",
        ]))
        gi = os.path.join(self.tmp, "boundary.gitignore")
        self.emit_boundary(reg, gi)
        with open(gi, "a", encoding="utf-8", newline="\n") as fh:
            fh.write("# a stray hand edit\n")
        rc, out, err = self.run_gate(
            ["compare", "--registry", reg, "--generated", gi,
             "--scan-repo", self.repo])
        self.assertEqual(rc, 3)
        self.assertTrue(out.startswith("PLACEMENT-BOUNDARY DRIFT"))

    def test_compare_migration_semantic_equivalence(self):
        self.init_repo()
        self.write_repo_file("keep/pub.md")
        self.git("add", ".")
        self.git("commit", "-m", "fixture")
        reg = self.write("registry.md", self.registry_text("N1", [
            row("pub-a", "keep/", "public-tracked", "PUBLIC"),
        ]))
        gi = os.path.join(self.tmp, "generated.boundary")
        with open(gi, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join([
                "# pa-framework public boundary - GENERATED file; do not edit by hand.",
                "# Source of truth: the placement registry's Boundary lines (N3) "
                "section; regenerate with pa/scripts/placement_gate.py gen --gitignore.",
                "",
                "/*",
                "!/.gitignore",
                "!/.gitignore-public",
                "!keep/",
            ]) + "\n")
        live = os.path.join(self.tmp, "pre-migration.boundary")
        with open(live, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join([
                "",
                "# legacy hand-written boundary",
                "",
                "/*",
                "",
                "!/.gitignore",
                "!/.gitignore-public",
                "!keep/",
                "# trailing note",
            ]) + "\n")
        rc, out, err = self.run_gate(
            ["compare", "--registry", reg, "--generated", gi, "--live", live,
             "--scan-repo", self.repo])
        self.assertEqual(rc, 0, out + err)
        self.assertIn("exposed=0 locked-out=0", out)
        self.assertRegex(out, r"PLACEMENT-BOUNDARY VERIFIED universe=\d+ agreed=\d+ "
                              r"exposed=0 locked-out=0")

    def test_compare_migration_exposed_and_locked_out(self):
        self.init_repo()
        self.write_repo_file("x/secret.bin")
        self.write_repo_file("y/pub.md")
        self.git("add", ".")
        self.git("commit", "-m", "fixture")
        reg = self.write("registry.md", self.registry_text("N1", [
            row("priv-a", "fixture prose surface", "private-excluded", "PRIVATE"),
        ]))
        gi = os.path.join(self.tmp, "generated.boundary")
        with open(gi, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join([
                "# generated header stands in here",
                "# second header line",
                "",
                "/*",
                "!/.gitignore",
                "!/.gitignore-public",
                "!x/",
                "x/*",
                "!x/secret.bin",
                "!y/",
                "y/pub.md",
            ]) + "\n")
        live = os.path.join(self.tmp, "pre-migration.boundary")
        with open(live, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join([
                "/*",
                "!/.gitignore",
                "!/.gitignore-public",
                "!x/",
                "x/*",
                "!y/",
            ]) + "\n")
        rc, out, err = self.run_gate(
            ["compare", "--registry", reg, "--generated", gi, "--live", live,
             "--scan-repo", self.repo])
        self.assertEqual(rc, 2)
        lines = out.splitlines()
        self.assertEqual(lines.count("PLACEMENT-BOUNDARY EXPOSED: x/secret.bin"), 1)
        self.assertEqual(lines.count("PLACEMENT-BOUNDARY LOCKED-OUT: y/pub.md"), 1)
        self.assertEqual(lines[-1],
                         "PLACEMENT-BOUNDARY MISMATCH exposed=1 locked-out=1")

    def test_compare_probe_catches_carveout_removal(self):
        # Nothing is tracked under proj/, so the tracked universe alone would agree;
        # the directory-prefix probe flips anyway. This pins why probes exist.
        self.init_repo()
        reg = self.write("registry.md", self.n3_only_registry([
            "L4:/*",
            "L7:!/.gitignore",
            "L8:!/.gitignore-public",
            "L20:proj/*",
            "L21:!proj/keep.md",
            "L22:!proj/",
        ]))
        gi = os.path.join(self.tmp, "generated.boundary")
        with open(gi, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join([
                "# generated header stands in here",
                "# second header line",
                "",
                "/*",
                "!/.gitignore",
                "!/.gitignore-public",
                "!proj/",
            ]) + "\n")
        live = os.path.join(self.tmp, "pre-migration.boundary")
        with open(live, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("\n".join([
                "/*",
                "!/.gitignore",
                "!/.gitignore-public",
                "proj/*",
                "!proj/keep.md",
            ]) + "\n")
        rc, out, err = self.run_gate(
            ["compare", "--registry", reg, "--generated", gi, "--live", live,
             "--scan-repo", self.repo])
        self.assertEqual(rc, 2)
        lines = out.splitlines()
        self.assertIn("PLACEMENT-BOUNDARY EXPOSED: proj/.pa-boundary-probe", lines)
        self.assertEqual(lines[-1],
                         "PLACEMENT-BOUNDARY MISMATCH exposed=1 locked-out=0")


if __name__ == "__main__":
    unittest.main()
