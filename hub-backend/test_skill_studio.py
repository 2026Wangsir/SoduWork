"""Skill Studio real export/import contract; isolated files only, no model or Hub writes."""
import base64
import json
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch
from app.services import plugin_packages, plugin_drafts, plugin_skill_cache

ROOT = Path(__file__).resolve().parent.parent
WRITER = ROOT / "skills/skill-studio/scripts/skill-package.cjs"
EXAMPLE = ROOT / "skills/skill-studio/assets/purchase-check"


class SkillStudioTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="soduwork-skill-contract-")
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.source = self.root / "purchase-check"
        shutil.copytree(EXAMPLE, self.source)
        (self.source / "assets").mkdir()
        (self.source / "assets/报价.csv").write_bytes("物料,数量\n灯具,2\n".encode())
        (self.source / "assets/example.png").write_bytes(b"\x89PNG\r\n\x1a\nfixture-only")
        self.output = self.root / "delivery"

    def build(self):
        result = subprocess.run(
            ["node", str(WRITER), "build", "--source", str(self.source), "--out", str(self.output)],
            capture_output=True, text=True, encoding="utf8", check=True)
        return json.loads(result.stdout)

    def test_independent_zip_reader_checks_all_targets_and_resource_bytes(self):
        report = self.build()
        for target in report["exports"]:
            with self.subTest(target=target["target"]), zipfile.ZipFile(self.output / target["file"]) as archive:
                self.assertIsNone(archive.testzip())
                self.assertEqual(set(archive.namelist()), set(target["files"]))
                for file in self.source.rglob("*"):
                    if file.is_file():
                        self.assertEqual(archive.read(target["skillRoot"] + file.relative_to(self.source).as_posix()),
                                         file.read_bytes())
                if target["target"] == "codex":
                    ui = archive.read(target["skillRoot"] + "agents/openai.yaml").decode()
                    self.assertIn("$purchase-check", ui)
                    self.assertNotIn("allow_implicit_invocation: false", ui)

    def test_soduwork_zip_import_local_draft_republish_and_runner_materialization(self):
        report = self.build()
        row = next(x for x in report["exports"] if x["target"] == "soduwork")
        package = self.output / row["file"]
        parsed = plugin_packages.parse(package.read_bytes())
        self.assertFalse(parsed["capabilities"]["hasWorkflow"])
        self.assertEqual(parsed["manifest"]["key"], "skill-purchase-check")
        self.assertFalse(parsed["signature"])
        self.assertEqual(parsed["capabilities"]["bundledSkills"][0]["name"], "purchase-check")
        restored = plugin_packages.personal_draft(parsed)
        resources = {x["path"]: base64.b64decode(x["content"]) for x in restored["resources"]}
        for file in self.source.rglob("*"):
            if file.is_file():
                self.assertEqual(resources["references/source/" + file.relative_to(self.source).as_posix()], file.read_bytes())
        # The existing draft publisher must remain able to republish it, not lose resources.
        republished = plugin_packages.parse(plugin_drafts.build(restored))
        self.assertEqual(parsed["resources"], republished["resources"])
        cache = self.root / "cache"
        with patch.object(plugin_skill_cache, "skill_root", return_value=str(cache)):
            actual = plugin_packages.materialize_skills(str(package), parsed["checksum"], parsed["capabilities"])
        loaded = Path(actual[0]["path"])
        self.assertEqual((loaded / "references/rules.md").read_bytes(), (self.source / "references/rules.md").read_bytes())
        self.assertEqual((loaded / "assets/报价.csv").read_bytes(), (self.source / "assets/报价.csv").read_bytes())

    def test_enterprise_definition_is_direct_and_canonical_skill_is_shipped_to_both_runtimes(self):
        raw = json.loads((ROOT / "hub-backend/plugins/skill-studio.json").read_text(encoding="utf8"))
        manifest, _, report = plugin_packages.normalize(raw)
        self.assertEqual(manifest["name"], "Skill 创建与优化")
        self.assertFalse(report["hasWorkflow"])
        self.assertIn("skill-studio", report["skills"])
        self.assertFalse(manifest["entrypoints"]["automation"])
        package = json.loads((ROOT / "client/package.json").read_text(encoding="utf8"))
        self.assertTrue(any(x.get("from") == "../skills" for x in package["build"]["extraResources"]))
        bootstrap = (ROOT / "hub-backend/app/services/plugin_bootstrap.py").read_text(encoding="utf8")
        self.assertIn('"skill-studio.json"', bootstrap)
        self.assertIn('trust_state="quarantined", enabled=False', bootstrap)
        self.assertIn("COPY skills", (ROOT / "ops/self-host/Dockerfile").read_text(encoding="utf8"))

    def test_folded_description_remains_readable_in_soduwork_import(self):
        file = self.source / "SKILL.md"
        content = file.read_text(encoding="utf8")
        import re
        content = re.sub(r'^description:.*$', 'description: >-\n  Check purchase inputs.\n  Report missing evidence.', content, flags=re.M)
        file.write_text(content, encoding="utf8")
        report = self.build()
        row = next(x for x in report["exports"] if x["target"] == "soduwork")
        parsed = plugin_packages.parse((self.output / row["file"]).read_bytes())
        self.assertEqual(parsed["capabilities"]["bundledSkills"][0]["description"],
                         "Check purchase inputs. Report missing evidence.")

    def test_soduwork_personal_draft_uses_existing_backend_exporter(self):
        self.build()
        raw = json.loads((self.output / "soduwork-plugin-draft.json").read_text(encoding="utf8"))
        parsed = plugin_packages.parse(plugin_drafts.build(raw))
        self.assertFalse(parsed["capabilities"]["hasWorkflow"])
        self.assertEqual(len(parsed["resources"]), 4)
        self.assertTrue(any(x["name"] == "purchase-check" for x in parsed["capabilities"]["bundledSkills"]))


    def test_exports_preserve_license_and_provenance_without_bundled_vendor_skills(self):
        documents = {"LICENSE": (ROOT / "LICENSE").read_bytes(),
                     "UPSTREAM.md": b"Isolated export fixture; no third-party content.\n"}
        for name, body in documents.items():
            (self.source / name).write_bytes(body)
        report = self.build()
        for row in report["exports"]:
            package = self.output / row["file"]
            with self.subTest(target=row["target"]), zipfile.ZipFile(package) as archive:
                for name, body in documents.items():
                    self.assertEqual(archive.read(row["skillRoot"] + name), body)
                if row["target"] == "soduwork":
                    restored = plugin_packages.personal_draft(plugin_packages.parse(package.read_bytes()))
                    resources = {x["path"]: base64.b64decode(x["content"]) for x in restored["resources"]}
                    for name, body in documents.items():
                        self.assertEqual(resources["references/source/" + name], body)


if __name__ == "__main__":
    unittest.main()
