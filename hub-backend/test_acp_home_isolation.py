"""Managed ACP homes must never fall back to inherited personal state."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from app.services import acp_agents, local_base

AGENTS = ("codex-harness", "qwen", "kimi", "dsh")


class AcpHomeIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-acp-home-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.personal = self.root / "personal"
        self.personal.mkdir()
        self.marker = self.personal / "private.json"
        self.marker.write_text("private-fixture-state", encoding="utf-8")

    def config(self, agent):
        spec = acp_agents.CATALOG[agent]["home"]
        root = self.root / agent
        root.mkdir()
        return spec, root, root / spec["folder"]

    def test_existing_file_blocks_home_without_changing_personal_state(self):
        for agent in AGENTS:
            with self.subTest(agent=agent):
                spec, root, home = self.config(agent)
                home.write_text("retained-collision", encoding="utf-8")
                env = {spec["env"]: str(self.personal)}
                with self.assertRaisesRegex(RuntimeError, "独立数据目录无法创建") as raised:
                    acp_agents.home_env(agent, env, str(root))
                self.assertNotIn(str(home), str(raised.exception))
                self.assertEqual(home.read_text(), "retained-collision")
                self.assertEqual(env, {spec["env"]: str(self.personal)})
                self.assertEqual(self.marker.read_text(), "private-fixture-state")

    def test_permission_failure_is_sanitized_and_never_acknowledged(self):
        for agent in AGENTS:
            with self.subTest(agent=agent):
                spec, root, home = self.config(agent)
                env = {spec["env"]: str(self.personal)}
                with patch.object(acp_agents.os, "makedirs", side_effect=PermissionError(
                        "personal-path fixture-private-token")):
                    with self.assertRaisesRegex(RuntimeError, "权限") as raised:
                        acp_agents.home_env(agent, env, str(root))
                self.assertNotIn("personal-path", str(raised.exception))
                self.assertNotIn("fixture-private-token", str(raised.exception))
                self.assertTrue(raised.exception.__suppress_context__)
                self.assertFalse(home.exists())
                self.assertEqual(env[spec["env"]], str(self.personal))

    def test_healthy_environment_uses_managed_home_and_preserves_inherited_files(self):
        llm = {"base": "http://127.0.0.1:9/v1", "key": "fixture-model-key", "model": "fixture"}
        for agent in AGENTS:
            with self.subTest(agent=agent):
                spec, root, home = self.config(agent)
                inherited = {spec["env"]: str(self.personal), "HOME": str(self.root / "os-home"),
                             "USERPROFILE": str(self.root / "os-home")}
                with patch.dict(os.environ, inherited), patch.object(local_base, "_data_root", return_value=str(root)):
                    env = local_base._env_for(local_base._PROFILES[agent], {"llm": llm}, "fixture")
                    resumed = local_base._env_for(local_base._PROFILES[agent], {"llm": llm}, "fixture")
                self.assertEqual(Path(env[spec["env"]]), home)
                self.assertEqual(resumed[spec["env"]], env[spec["env"]])
                self.assertTrue(home.is_dir())
                self.assertEqual(self.marker.read_text(), "private-fixture-state")
                self.assertEqual(list(self.personal.iterdir()), [self.marker])

    def test_real_runner_refuses_failed_home_and_retries_after_repair(self):
        fixture = Path(__file__).with_name("tests") / "acp_home_runner_fixture.py"
        for agent in AGENTS:
            with self.subTest(agent=agent):
                process = subprocess.run([sys.executable, str(fixture), agent, str(self.root / agent)],
                    capture_output=True, text=True, encoding="utf-8", timeout=40)
                self.assertEqual(process.returncode, 0, process.stdout + process.stderr)
                report = json.loads(process.stdout.strip().splitlines()[-1])
                self.assertTrue(report["blockedBeforeExecutor"])
                self.assertTrue(report["healthyRetry"])
                self.assertTrue(report["personalStateUnchanged"])
                self.assertTrue(report["localModelReady"])


if __name__ == "__main__":
    unittest.main()
