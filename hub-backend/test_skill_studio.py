"""Skill Studio real export/import contract; isolated files only, no model or Hub writes."""
import hashlib
import json
import os
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

# Import-time development settings must never create credentials in the checkout.
for key, value in {
    "AUTH_SECRET": "skill-studio-isolated-contract-signing-secret",
    "ADMIN_PASS": "skill-studio-isolated-contract-password",
    "DATABASE_URL": "sqlite+aiosqlite:///:memory:",
}.items():
    if not os.environ.get(key):
        os.environ[key] = value

from app.services import plugin_packages, runner_skills, skill_packages

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

    def test_soduwork_package_import_and_runner_materialization(self):
        report = self.build()
        row = next(x for x in report["exports"] if x["target"] == "soduwork")
        package = self.output / row["file"]
        self.assertEqual(package.suffix, ".skill")
        parsed = skill_packages.parse(package.read_bytes(), package.name)
        self.assertEqual(parsed["name"], "purchase-check")
        self.assertEqual(parsed["fileCount"], 4)
        for file in self.source.rglob("*"):
            if file.is_file():
                self.assertEqual(parsed["files"][file.relative_to(self.source).as_posix()], file.read_bytes())
        with patch.object(skill_packages, "root", return_value=str(self.root / "skill-store")):
            installed = skill_packages.install(parsed, "personal", "fixture-owner")
            self.assertEqual(installed["scope"], "personal")
            self.assertEqual(skill_packages.active(owner_client_id="fixture-owner"), [installed])
            self.assertEqual(skill_packages.active(owner_client_id="other-owner"), [])
            self.assertEqual(skill_packages.install(parsed, "personal", "fixture-owner")["path"], installed["path"])
            self.assertEqual(len(skill_packages.active(owner_client_id="fixture-owner")), 1)
            bundle = runner_skills.build([installed])
        with patch.object(runner_skills, "_data_root", return_value=str(self.root / "runner-cache")):
            actual = runner_skills.install(bundle, hashlib.sha256(bundle).hexdigest())
        self.assertEqual(actual[0]["name"], "purchase-check")
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
        parsed = skill_packages.parse((self.output / row["file"]).read_bytes())
        self.assertEqual(parsed["description"],
                         "Check purchase inputs. Report missing evidence.")

    def test_skill_installation_preserves_scripts_without_running_them(self):
        sentinel = self.root / "must-not-exist"
        scripts = self.source / "scripts"
        scripts.mkdir()
        script = ("from pathlib import Path\nPath(%r).write_text('BAD')\n" % str(sentinel)).encode()
        (scripts / "business.py").write_bytes(script)
        report = self.build()
        row = next(x for x in report["exports"] if x["target"] == "soduwork")
        parsed = skill_packages.parse((self.output / row["file"]).read_bytes())
        with patch.object(skill_packages, "root", return_value=str(self.root / "skill-store")):
            installed = skill_packages.install(parsed, "personal", "fixture-owner")
        self.assertTrue(parsed["hasScripts"])
        self.assertEqual((Path(installed["path"]) / "scripts/business.py").read_bytes(), script)
        self.assertFalse(sentinel.exists())
        self.assertFalse((self.output / "soduwork-plugin-draft.json").exists())


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
                    restored = skill_packages.parse(package.read_bytes())
                    for name, body in documents.items():
                        self.assertEqual(restored["files"][name], body)


if __name__ == "__main__":
    unittest.main()
