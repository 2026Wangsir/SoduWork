"""Keep native smoke discovery aligned with the public Client build contract."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from client_test_payload import CLIENT, windows_payload
from scripts.check_packaged_runner_task import delivered_node, verify_pi_configuration


class ClientTestPayloadTests(unittest.TestCase):
    def test_packaged_runner_accepts_real_execution_scoped_pi_configuration(self):
        from app.services.pi_runtime_config import prepare
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            llm = {"base": "http://127.0.0.1:9/v1", "key": "fixture-private-key", "model": "fixture"}
            prepare({}, str(root / "data"), llm, 128000, "first-dispatch")
            models = verify_pi_configuration(root, "first-dispatch", llm)
            self.assertTrue(models.is_file())
            with self.assertRaisesRegex(AssertionError, "execution-owned"):
                verify_pi_configuration(root, "another-dispatch", llm)

    def test_packaged_runner_rejects_legacy_only_pi_configuration(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            legacy = root / "profile/.pi/agent/models.json"
            legacy.parent.mkdir(parents=True)
            legacy.write_text("{}", encoding="utf-8")
            with self.assertRaisesRegex(AssertionError, "execution-owned"):
                verify_pi_configuration(root, "dispatch", {})

    def test_packaged_runner_rejects_wrong_model_credentials_and_personal_writes(self):
        from app.services.pi_runtime_config import prepare
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            llm = {"base": "http://127.0.0.1:9/v1", "key": "fixture-private-key", "model": "fixture"}
            prepare({}, str(root / "data"), llm, 128000, "dispatch")
            models = verify_pi_configuration(root, "dispatch", llm)
            original = models.read_text(encoding="utf-8")
            for field, value in (("baseUrl", "http://127.0.0.1:8/v1"),
                                 ("models", [{"id": "wrong-model"}]), ("apiKey", llm["key"]),
                                 ("unusedCredential", llm["key"])):
                with self.subTest(field=field):
                    content = json.loads(original)
                    content["providers"]["company"][field] = value
                    models.write_text(json.dumps(content), encoding="utf-8")
                    with self.assertRaises(AssertionError):
                        verify_pi_configuration(root, "dispatch", llm)
            models.write_text(original, encoding="utf-8")
            legacy = root / "profile/.pi/agent/models.json"
            legacy.parent.mkdir(parents=True)
            legacy.write_text(original, encoding="utf-8")
            with self.assertRaisesRegex(AssertionError, "personal"):
                verify_pi_configuration(root, "dispatch", llm)

    def test_runner_uses_the_explicit_delivered_runtime_without_cross_payload_fallback(self):
        with tempfile.TemporaryDirectory() as directory:
            payload = Path(directory) / "payload"
            payload.mkdir()
            executable = payload / windows_payload("self-hosted")[1].name
            executable.write_bytes(b"fixture")
            self.assertEqual(delivered_node(payload, executable), executable)
            outside = Path(directory) / "another.exe"
            outside.write_bytes(b"fixture")
            for invalid in (outside, payload / "missing.exe", payload / "SoduWork.cmd"):
                with self.subTest(invalid=invalid.name):
                    with self.assertRaises(AssertionError):
                        delivered_node(payload, invalid)

    def test_public_native_smoke_payload_matches_builder_and_runtime_identity(self):
        node = shutil.which("node")
        self.assertIsNotNone(node, "Client packaging contract requires Node")
        script = """
const config = require('./package.json');
const profile = require('./main/distribution.cjs').getProfile('self-hosted');
console.log(JSON.stringify({ directory: config.build.directories.output,
  executable: profile.windowsExecutableName + '.exe' }));
"""
        built = json.loads(subprocess.check_output([node, "-e", script], cwd=CLIENT, text=True))
        with patch.dict(os.environ, {"SODUWORK_DISTRIBUTION": "self-hosted"}):
            payload, executable, shell = windows_payload()
        self.assertEqual(payload, CLIENT / built["directory"] / "win-unpacked")
        self.assertEqual(executable, payload / built["executable"])
        self.assertEqual(shell, payload / "resources" / "shell")
        self.assertFalse((CLIENT / "distributions.json").exists(), "Omitted edition configuration must stay omitted")

    def test_missing_selection_uses_public_profile_and_unknown_values_never_fall_back(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(windows_payload(), windows_payload("self-hosted"))
        for invalid in ("", "unknown", "../self-hosted", "internal", "cn", "global"):
            with self.subTest(distribution=invalid):
                with patch.dict(os.environ, {"SODUWORK_DISTRIBUTION": invalid}):
                    with self.assertRaisesRegex(ValueError, "Unknown public Client distribution"):
                        windows_payload()


if __name__ == "__main__":
    unittest.main()
