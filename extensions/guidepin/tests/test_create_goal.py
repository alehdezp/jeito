"""Deterministic scaffold checks in disposable directories; no agent sessions."""
import contextlib
import io
import json
import runpy
import shutil
import subprocess
import sys
import tempfile
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest import mock

SKILL = Path(__file__).resolve().parents[1] / "skills" / "goal-management"
SCRIPT = SKILL / "scripts" / "create_goal.py"
FILENAMES = {"goal.md", "work.md", "decisions.md"}


class CreateGoalTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.project = Path(self.temporary.name)

    def run_goal(self, *arguments, project=None, script=SCRIPT):
        return subprocess.run(
            [sys.executable, "-B", str(script), "--project", str(project or self.project), *arguments],
            cwd=self.project,
            capture_output=True,
            text=True,
            timeout=10,
        )

    def test_creates_only_three_draft_files_with_owned_templates(self):
        title = 'Caches: "stable" café'
        result = self.run_goal("cache-understanding", "--title", title)
        self.assertEqual(result.returncode, 0, result.stderr)
        folder = self.project / ".pi" / "goals" / "cache-understanding"
        self.assertEqual({p.name for p in folder.iterdir()}, FILENAMES)
        self.assertEqual({p.name for p in (self.project / ".pi").iterdir()}, {"goals"})
        for filename in FILENAMES:
            content = (folder / filename).read_text(encoding="utf-8")
            _, metadata, body = content.split("---", 2)
            fields = dict(line.split(": ", 1) for line in metadata.strip().splitlines())
            self.assertEqual(set(fields), {"title", "description", "tags", "created", "updated", "status", "owns"})
            self.assertEqual(fields["status"], "draft")
            updated = json.loads(fields["updated"])
            self.assertRegex(updated, r"^\d{4}-\d{2}-\d{2} (?:[01]\d|2[0-3])Z$")
            self.assertEqual(fields["created"], updated[:10])
            self.assertRegex(fields["created"], r"^\d{4}-\d{2}-\d{2}$")
            self.assertTrue(json.loads(fields["title"]).startswith(title + " — "))
            self.assertTrue(json.loads(fields["owns"]))
            self.assertIn(f"# {title} — ", body)
            template = (SKILL / "templates" / filename).read_text(encoding="utf-8")
            self.assertTrue(body.endswith(template.rstrip() + "\n"))
        goal = (folder / "goal.md").read_text(encoding="utf-8")
        work = (folder / "work.md").read_text(encoding="utf-8")
        self.assertIn("## Boundaries and near misses", goal)
        self.assertIn("provisional interpretation", goal)
        self.assertIn("## Understanding that shapes this goal", goal)
        self.assertIn("Agreed direction:", goal)
        self.assertIn("Established facts:", goal)
        self.assertIn("not a project briefing", goal)
        self.assertIn("not a list of implementation steps", work)
        self.assertIn("Silence is not approval", work)
        self.assertIn("Remove possibilities contradicted by the user", work)
        # Sample branches are comments, not invented open work.
        self.assertIn("### S1", work.split("<!-- Branch format:", 1)[1].split("-->", 1)[0])
        self.assertIn("### P1", work.split("<!-- Pending format:", 1)[1].split("-->", 1)[0])

    def test_defaults_to_caller_directory_without_selecting_a_goal(self):
        result = subprocess.run(
            [sys.executable, "-B", str(SCRIPT), "plain-goal"],
            cwd=self.project, capture_output=True, text=True, timeout=10,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        folder = self.project / ".pi" / "goals" / "plain-goal"
        self.assertIn("Plain goal — Current intent", (folder / "goal.md").read_text())
        self.assertEqual(sorted(p.name for p in self.project.iterdir()), [".pi"])
        self.assertEqual(sorted(p.name for p in folder.parent.iterdir()), ["plain-goal"])

    def test_existing_goal_is_never_overwritten_or_extended(self):
        self.assertEqual(self.run_goal("existing").returncode, 0)
        folder = self.project / ".pi" / "goals" / "existing"
        (folder / "goal.md").write_text("user-owned understanding\n")
        before = {p.name: p.read_bytes() for p in folder.iterdir()}
        result = self.run_goal("existing", "--title", "Replacement")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not overwritten", result.stderr)
        self.assertEqual({p.name: p.read_bytes() for p in folder.iterdir()}, before)
        self.assertNotEqual(self.run_goal("existing", "--force").returncode, 0)

    def test_existing_empty_folder_or_file_is_not_repaired(self):
        goals = self.project / ".pi" / "goals"
        goals.mkdir(parents=True)
        (goals / "empty").mkdir()
        (goals / "file").write_text("owned")
        for slug in ("empty", "file"):
            with self.subTest(slug=slug):
                self.assertNotEqual(self.run_goal(slug).returncode, 0)
        self.assertEqual(list((goals / "empty").iterdir()), [])
        self.assertEqual((goals / "file").read_text(), "owned")

    def test_invalid_names_and_multiline_titles_create_nothing(self):
        for slug in ("../escape", "Upper", "a/b", "a--b", "-a", "a-", "", "with space"):
            with self.subTest(slug=slug):
                self.assertNotEqual(self.run_goal(slug).returncode, 0)
        for title in ("", " ", "a\nb", "a\r", "a\u2028b"):
            with self.subTest(title=title):
                self.assertNotEqual(self.run_goal("valid", "--title", title).returncode, 0)
        self.assertEqual(list(self.project.iterdir()), [])

    def test_project_must_already_be_a_directory(self):
        missing = self.project / "missing"
        self.assertNotEqual(self.run_goal("goal", project=missing).returncode, 0)
        self.assertFalse(missing.exists())
        file = self.project / "file"
        file.write_text("owned")
        self.assertNotEqual(self.run_goal("goal", project=file).returncode, 0)
        self.assertEqual(file.read_text(), "owned")

    def test_symlinked_parents_are_refused_even_when_dangling(self):
        outside = self.project / "outside"
        outside.mkdir()
        for parent_name in (".pi", ".pi/goals"):
            for target in (outside, self.project / "missing-target"):
                with self.subTest(parent=parent_name, target=target):
                    with tempfile.TemporaryDirectory(dir=self.project) as project:
                        link = Path(project) / parent_name
                        link.parent.mkdir(parents=True, exist_ok=True)
                        link.symlink_to(target, target_is_directory=True)
                        result = self.run_goal("goal", project=Path(project))
                        self.assertNotEqual(result.returncode, 0)
                        self.assertIn("symlink", result.stderr)
        self.assertEqual(list(outside.iterdir()), [])
        self.assertFalse((self.project / "missing-target").exists())

    def test_existing_goal_symlink_is_never_followed(self):
        goals = self.project / ".pi" / "goals"
        goals.mkdir(parents=True)
        outside = self.project / "outside"
        outside.mkdir()
        (goals / "linked").symlink_to(outside, target_is_directory=True)
        self.assertNotEqual(self.run_goal("linked").returncode, 0)
        self.assertEqual(list(outside.iterdir()), [])

    def test_missing_template_fails_before_destination_creation(self):
        copied_skill = self.project / "skill"
        copied_script = copied_skill / "scripts" / SCRIPT.name
        copied_script.parent.mkdir(parents=True)
        shutil.copyfile(SCRIPT, copied_script)
        (copied_skill / "templates").mkdir()
        shutil.copyfile(SKILL / "templates" / "goal.md", copied_skill / "templates" / "goal.md")
        result = self.run_goal("goal", script=copied_script)
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse((self.project / ".pi").exists())

    def test_partial_write_reports_failure_and_preserves_created_files(self):
        main = runpy.run_path(str(SCRIPT))["main"]
        original_open = Path.open

        def fail_second_output(path, mode="r", *args, **kwargs):
            if path.name == "work.md" and mode == "x":
                raise PermissionError("controlled write failure")
            return original_open(path, mode, *args, **kwargs)

        error = io.StringIO()
        with mock.patch.object(sys, "argv", [str(SCRIPT), "partial", "--project", str(self.project)]):
            with mock.patch.object(Path, "open", fail_second_output), contextlib.redirect_stderr(error):
                with self.assertRaises(SystemExit) as stopped:
                    main()
        self.assertEqual(stopped.exception.code, 1)
        self.assertIn("controlled write failure", error.getvalue())
        self.assertIn("inspect the incomplete folder", error.getvalue())
        folder = self.project / ".pi" / "goals" / "partial"
        before = (folder / "goal.md").read_bytes()
        self.assertEqual({p.name for p in folder.iterdir()}, {"goal.md"})
        self.assertNotEqual(self.run_goal("partial").returncode, 0)
        self.assertEqual((folder / "goal.md").read_bytes(), before)

    def test_competing_creators_do_not_overwrite_each_other(self):
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: self.run_goal("shared"), range(2)))
        self.assertEqual(sorted(result.returncode for result in results), [0, 1])
        folder = self.project / ".pi" / "goals" / "shared"
        self.assertEqual({p.name for p in folder.iterdir()}, FILENAMES)


if __name__ == "__main__":
    unittest.main()
