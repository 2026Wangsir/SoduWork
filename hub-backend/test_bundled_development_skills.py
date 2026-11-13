"""Exercise the requested development catalog through real discovery and packaging."""
from pathlib import Path
import io
import shutil
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch
import zipfile

from app.services import runner_sources, skill_content, skill_packages, skill_read_scope, skills


PROJECT = Path(__file__).resolve().parents[1]
REQUESTED = frozenset({
    "code-review", "codebase-design", "diagnosing-bugs", "domain-modeling",
    "grill-with-docs", "improve-codebase-architecture", "prototype",
    "resolving-merge-conflicts", "tdd", "wizard", "browser-use", "computer-use",
    "frontend-design", "using-superpowers", "brainstorming", "writing-plans",
    "executing-plans", "subagent-driven-development", "dispatching-parallel-agents",
    "test-driven-development", "systematic-debugging", "verification-before-completion",
    "requesting-code-review", "receiving-code-review", "finishing-a-development-branch",
    "using-git-worktrees", "writing-skills",
})
RESTORED = REQUESTED - {"browser-use", "computer-use"}
DEPENDENCIES = frozenset({"grilling"})
SUPPORT_FILES = {
    "codebase-design": {"DEEPENING.md", "DESIGN-IT-TWICE.md"},
    "diagnosing-bugs": {"scripts/hitl-loop.template.sh"},
    "domain-modeling": {"ADR-FORMAT.md", "CONTEXT-FORMAT.md"},
    "grill-with-docs": {"references/grilling/GUIDE.md", "references/domain-modeling/GUIDE.md"},
    "improve-codebase-architecture": {"HTML-REPORT.md", "references/codebase-design/GUIDE.md",
                                     "references/domain-modeling/GUIDE.md"},
    "prototype": {"UI.md", "LOGIC.md"},
    "requesting-code-review": {"code-reviewer.md"},
    "subagent-driven-development": {"implementer-prompt.md", "task-reviewer-prompt.md",
                                    "re-review-prompt.md", "scripts/task-brief",
                                    "scripts/review-package", "scripts/sdd-workspace"},
    "tdd": {"tests.md", "mocking.md", "references/codebase-design/GUIDE.md"},
    "using-superpowers": {"references/pi-tools.md", "references/codex-tools.md"},
    "wizard": {"template.sh"},
    "writing-plans": {"plan-document-reviewer-prompt.md"},
}


def catalog(test, root=None):
    rows = skills.scan_root(str(root or PROJECT / "skills"))
    names = [row["name"] for row in rows]
    required = REQUESTED | DEPENDENCIES
    test.assertEqual(len(names), len(set(names)), "Skill identities must be unique")
    test.assertFalse(required - set(names),
                     "Missing skills or dependencies: " + ", ".join(sorted(required - set(names))))
    return {row["name"]: row for row in rows if row["name"] in required}


class BundledDevelopmentSkillTests(unittest.TestCase):
    def test_hub_discovers_valid_catalog_and_dispatches_real_skill_paths(self):
        rows = catalog(self)
        with patch.object(skills, "bundled_root", return_value=str(PROJECT / "skills")):
            for name, row in rows.items():
                with self.subTest(name=name):
                    self.assertEqual(Path(row["path"]), PROJECT / "skills" / name)
                    public = skills.public_view(row)
                    self.assertEqual(public["sourceKey"], "builtin")
                    self.assertTrue(public["description"].strip())
                    self.assertNotIn("path", public)
                    self.assertNotIn("root", public)
                    self.assertEqual(skills.cli_args([row], "pi"), ["--skill", row["path"]])
                    self.assertIn(row["path"], skills.prompt_block([row], native=False))

    def test_skill_exports_preserve_all_support_files_and_original_notices(self):
        for name, row in catalog(self).items():
            with self.subTest(name=name):
                source = skill_content.read_files(row["path"])
                exported = skill_content.archive(source)
                parsed = skill_packages.parse(exported, name + ".zip")
                self.assertEqual(parsed["name"], name)
                self.assertEqual(parsed["description"], row["description"])
                self.assertEqual(parsed["files"], source)
                self.assertFalse(SUPPORT_FILES.get(name, set()) - parsed["files"].keys(),
                                 "Exported skill is missing a referenced method or script")
                if name in RESTORED | DEPENDENCIES:
                    license_names = {"LICENSE", "LICENSE.txt"} & parsed["files"].keys()
                    self.assertTrue(license_names, "An original license must accompany the skill")
                    self.assertIn("UPSTREAM.md", parsed["files"])
                    for license_name in license_names:
                        self.assertGreater(len(parsed["files"][license_name]), 80)
                    self.assertGreater(len(parsed["files"]["UPSTREAM.md"]), 80)

    def test_runner_resource_selection_retains_discoverable_skill_trees(self):
        original = catalog(self)
        source_files = runner_sources.skill_files(PROJECT)
        with tempfile.TemporaryDirectory(prefix="soduwork-bundled-skills-") as directory:
            extracted = Path(directory)
            for source in source_files:
                destination = extracted / source.relative_to(PROJECT)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, destination)
            # Exercise the actual frozen-runtime root rule without building an executable.
            with patch.object(sys, "_MEIPASS", directory, create=True):
                loaded = catalog(self, Path(skills.bundled_root()))
                self.assertEqual(set(loaded), set(original))
                for name, row in loaded.items():
                    with self.subTest(name=name):
                        self.assertEqual(skill_content.read_files(row["path"]),
                                         skill_content.read_files(original[name]["path"]))
                        localized = skill_read_scope.localize(
                            [{"name": name, "path": "/untrusted/incoming/path"}], list(loaded.values()))
                        self.assertEqual(len(localized), 1)
                        self.assertEqual(localized[0]["path"], row["path"])
                        self.assertNotEqual(row["path"], original[name]["path"])

    @unittest.skipUnless(shutil.which("bash"), "Exported shell helpers require an available Bash runtime")
    def test_exported_sdd_helpers_work_without_executable_file_modes(self):
        source = PROJECT / "skills" / "subagent-driven-development"
        files = skill_content.read_files(str(source))
        with tempfile.TemporaryDirectory(prefix="soduwork-skill-helpers-") as directory:
            root = Path(directory)
            delivered = root / "delivered skill"
            with zipfile.ZipFile(io.BytesIO(skill_content.archive(files))) as archive:
                archive.extractall(delivered)
            for name in files:
                (delivered / name).chmod(0o644)
            project = root / "target project"
            project.mkdir()
            hooks = root / "empty-hooks"
            hooks.mkdir()

            def command(*args):
                result = subprocess.run(args, cwd=project, capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                return result.stdout.strip()

            def git(*args):
                return command("git", "-c", "user.name=Skill Fixture", "-c",
                               "user.email=skill-fixture@example.test", "-c", "commit.gpgsign=false",
                               "-c", "core.hooksPath=" + str(hooks), *args)

            git("init", "-q")
            git("commit", "--allow-empty", "-s", "-qm", "Create fixture base")
            base = git("rev-parse", "HEAD")
            plan = project / "plan.md"
            plan.write_text("# Plan\n\n### Task 1: Preserve output\nCreate a fixture.\n", encoding="utf-8")
            git("add", "plan.md")
            git("commit", "-s", "-qm", "Add fixture plan")
            head = git("rev-parse", "HEAD")
            command(shutil.which("bash"), (delivered / "scripts/task-brief").as_posix(), plan.as_posix(), "1")
            command(shutil.which("bash"), (delivered / "scripts/review-package").as_posix(), plan.as_posix(), base, head)
            workspace = project / ".superpowers" / "sdd" / "plan"
            self.assertIn("Create a fixture.", (workspace / "task-1-brief.md").read_text(encoding="utf-8"))
            reviews = list(workspace.glob("review-*.diff"))
            self.assertEqual(len(reviews), 1)
            self.assertIn("Add fixture plan", reviews[0].read_text(encoding="utf-8"))
            self.assertEqual(skill_content.read_files(str(delivered)), files,
                             "Helper execution must not modify the installed skill package")


class BundledDevelopmentSkillPolicyTests(unittest.IsolatedAsyncioTestCase):
    async def test_explicit_administrator_revocation_still_blocks_bundled_skills(self):
        rows = catalog(self)
        cfg = {"allowed": [], "roots": [], "byRepo": {}}
        with patch.object(skills, "catalog_with_policy", AsyncMock(return_value=(cfg, list(rows.values())))):
            for name in sorted(RESTORED | DEPENDENCIES):
                with self.subTest(name=name):
                    with self.assertRaisesRegex(ValueError, name):
                        await skills.resolve_named(None, [name])
            cfg["allowed"] = sorted(RESTORED | DEPENDENCIES)
            resolved = await skills.resolve_named(None, sorted(RESTORED | DEPENDENCIES))
            self.assertEqual({row["name"] for row in resolved}, RESTORED | DEPENDENCIES)
            for row in resolved:
                self.assertEqual(row["path"], rows[row["name"]]["path"])


if __name__ == "__main__":
    unittest.main()
