"""Dispatched Pi turns must read their own model configuration and credentials."""
import json
import os
from pathlib import Path
import tempfile
import unittest
import uuid
from unittest.mock import patch

from app.services import local_base
from app.services import pi_runtime_config


class PiRuntimeConfigTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="soduwork-pi-config-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.desktop = self.root / "desktop-pi"
        self.personal = self.root / "home/.pi/agent"
        for directory in (self.desktop, self.personal):
            directory.mkdir(parents=True)
            (directory / "models.json").write_text("private-original", encoding="utf-8")
        self.parent_environment = {
            "SODUWORK_DATA_ROOT": str(self.root / "runner"),
            "HOME": str(self.root / "home"), "USERPROFILE": str(self.root / "home"),
            "PI_CODING_AGENT_DIR": str(self.desktop),
            "PI_CODING_AGENT_SESSION_DIR": str(self.desktop / "sessions"),
        }
        self.llm = {"base": "http://127.0.0.1:9/v1", "key": "fixture-private-key",
                    "model": "fixture", "contextWindow": 128000,
                    "maxOutputTokens": 32768, "imageRouting": "native"}

    def environment(self, ref="dispatch-one", llm=None):
        with patch.dict(os.environ, self.parent_environment):
            return local_base._env_for(local_base._PROFILES["pi"],
                                       {"llm": self.llm if llm is None else llm}, runtime_ref=ref)

    def test_child_reads_its_managed_config_without_mutating_private_models(self):
        env = self.environment()
        directory = Path(env["PI_CODING_AGENT_DIR"])
        self.assertTrue(directory.is_relative_to(self.root / "runner"))
        self.assertEqual(Path(env["PI_CODING_AGENT_SESSION_DIR"]), directory / "sessions")
        content = (directory / "models.json").read_text(encoding="utf-8")
        provider = json.loads(content)["providers"]["company"]
        self.assertEqual(provider["models"][0]["id"], "fixture")
        self.assertEqual(provider["models"][0]["maxTokens"], 32768)
        self.assertEqual(provider["models"][0]["input"], ["text", "image"])
        self.assertEqual(provider["apiKey"], "$SODUWORK_LLM_KEY")
        self.assertNotIn(self.llm["key"], content)
        self.assertEqual(env["SODUWORK_LLM_KEY"], self.llm["key"])
        for original in (self.desktop, self.personal):
            self.assertEqual((original / "models.json").read_text(), "private-original")
        self.assertEqual(env["HOME"], self.parent_environment["HOME"])

    def test_separate_dispatches_cannot_replace_each_others_model(self):
        first = self.environment()
        second = self.environment("dispatch-two", {**self.llm, "model": "other", "key": "other-key"})
        self.assertNotEqual(first["PI_CODING_AGENT_DIR"], second["PI_CODING_AGENT_DIR"])
        for env, model in ((first, "fixture"), (second, "other")):
            content = json.loads((Path(env["PI_CODING_AGENT_DIR"]) / "models.json").read_text())
            self.assertEqual(content["providers"]["company"]["models"][0]["id"], model)
        restored = self.environment()
        self.assertEqual(restored["PI_CODING_AGENT_DIR"], first["PI_CODING_AGENT_DIR"])

    def test_keyless_local_model_omits_inherited_credentials(self):
        with patch.dict(os.environ, {"SODUWORK_LLM_KEY": "unrelated-personal-key"}):
            env = self.environment(llm={**self.llm, "key": "", "localOnly": True})
        provider = json.loads((Path(env["PI_CODING_AGENT_DIR"]) / "models.json").read_text())["providers"]["company"]
        self.assertEqual(provider["apiKey"], "soduwork-local-no-key")
        self.assertNotIn("SODUWORK_LLM_KEY", env)

    def test_missing_model_configuration_fails_before_cli_start(self):
        for field in ("base", "key", "model"):
            with self.subTest(field=field), self.assertRaises(RuntimeError):
                self.environment(llm={**self.llm, field: ""})

    def test_failed_publication_preserves_previous_config_and_hides_error_details(self):
        env = self.environment()
        target = Path(env["PI_CODING_AGENT_DIR"]) / "models.json"
        original = target.read_bytes()
        with patch.object(pi_runtime_config.os, "replace", side_effect=PermissionError("private fixture path")):
            with self.assertRaisesRegex(RuntimeError, "Pi 模型配置无法写入") as raised:
                self.environment(llm={**self.llm, "model": "changed"})
        self.assertNotIn("private fixture path", str(raised.exception))
        self.assertEqual(target.read_bytes(), original)
        self.assertEqual(list(target.parent.glob(".models-*")), [])
        with patch.object(pi_runtime_config.os, "replace", side_effect=AssertionError("No redundant writes")):
            restored = self.environment()
        self.assertEqual(restored["PI_CODING_AGENT_DIR"], env["PI_CODING_AGENT_DIR"])

    def test_config_directory_failure_is_fatal(self):
        (self.root / "runner").write_text("not a directory")
        with self.assertRaisesRegex(RuntimeError, "Pi 模型配置无法写入"):
            self.environment()

    def test_runtime_refs_cannot_escape_and_probes_do_not_share_config(self):
        env = self.environment("../../outside")
        self.assertTrue(Path(env["PI_CODING_AGENT_DIR"]).is_relative_to(self.root / "runner"))
        self.assertNotEqual(self.environment("")["PI_CODING_AGENT_DIR"],
                            self.environment("")["PI_CODING_AGENT_DIR"])

    def test_anthropic_dispatch_retains_its_transport(self):
        env = self.environment(llm={**self.llm, "kind": "anthropic"})
        value = json.loads((Path(env["PI_CODING_AGENT_DIR"]) / "models.json").read_text())
        self.assertEqual(value["providers"]["company"]["api"], "anthropic-messages")
        self.assertNotIn("compat", value["providers"]["company"])

    def test_other_runtimes_do_not_rewrite_pi_environment(self):
        with patch.dict(os.environ, self.parent_environment):
            env = local_base._env_for({"name": "Native", "needs_llm": False}, {}, "native")
        for key in ("PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"):
            self.assertEqual(env[key], self.parent_environment[key])
        self.assertFalse((self.root / "runner").exists())

    def historical_session(self, *, owner=True):
        sid = str(uuid.uuid4())
        workspace = str(self.root / "work")
        source = self.desktop / "sessions" / ("fixture_" + sid + ".jsonl")
        source.parent.mkdir()
        source.write_text(json.dumps({"type": "session", "version": 3, "id": sid,
            "cwd": workspace if owner else str(self.root / "another-workspace")}) + "\n", encoding="utf-8")
        run = {"cliSid": sid, "ws": workspace, "lines": [{"kind": "say", "text": "prior result"}]}
        return source, run

    def test_upgrade_imports_only_exact_owned_session_and_preserves_original(self):
        source, run = self.historical_session()
        original = source.read_bytes()
        unrelated = source.with_name("unrelated_" + str(uuid.uuid4()) + ".jsonl")
        unrelated.write_text("private invalid content")
        with patch.dict(local_base._RUNS, {"dispatch-one": run}):
            env = self.environment()
            args = local_base._pi_args(run["cliSid"], "work", {"llm": self.llm}, resume=True)
        copied = Path(env["PI_CODING_AGENT_SESSION_DIR"]) / source.name
        self.assertEqual(copied.read_bytes(), original)
        self.assertEqual(source.read_bytes(), original)
        self.assertEqual(list(copied.parent.iterdir()), [copied])
        self.assertIn("--session", args)
        self.assertNotIn("--session-id", args)

    def test_upgrade_rejects_same_id_in_another_workspace(self):
        source, run = self.historical_session(owner=False)
        with patch.dict(local_base._RUNS, {"dispatch-one": run}):
            with self.assertRaisesRegex(RuntimeError, "原执行会话无法安全恢复"):
                self.environment()
        self.assertTrue(source.exists())

    def test_upgrade_finds_default_home_session_without_reading_other_sessions(self):
        source, run = self.historical_session()
        encoded = "--" + run["ws"].lstrip("/\\").replace("/", "-").replace("\\", "-").replace(":", "-") + "--"
        legacy = self.personal / "sessions" / encoded / source.name
        legacy.parent.mkdir(parents=True)
        source.rename(legacy)
        with patch.dict(local_base._RUNS, {"dispatch-one": run}):
            env = self.environment()
        self.assertEqual((Path(env["PI_CODING_AGENT_SESSION_DIR"]) / legacy.name).read_bytes(),
                         legacy.read_bytes())

    def test_duplicate_owned_session_is_not_chosen_arbitrarily(self):
        source, run = self.historical_session()
        duplicate = source.with_name("duplicate_" + run["cliSid"] + ".jsonl")
        duplicate.write_bytes(source.read_bytes())
        with patch.dict(local_base._RUNS, {"dispatch-one": run}):
            with self.assertRaisesRegex(RuntimeError, "原执行会话无法安全恢复"):
                self.environment()

    def test_lost_history_requires_existing_session_but_initial_failure_can_retry(self):
        sid = str(uuid.uuid4())
        for lines, flag in (([{"kind": "say"}], "--session"),
                            ([{"kind": "out", "tool": "stderr"}], "--session-id")):
            with patch.dict(local_base._RUNS, {"dispatch-one": {"cliSid": sid, "lines": lines}}):
                args = local_base._pi_args(sid, "work", {"llm": self.llm}, resume=True)
                self.assertIn(flag, args)
                start = local_base._pi_args(sid, "work", {"llm": self.llm})
                self.assertIn("--session-id", start)

    def test_recovered_terminal_reuses_owned_directory_without_model_credentials(self):
        from app.services.terminal_environment import runner_environment
        source, run = self.historical_session()
        run.update(taskId="task", cli="pi", cfg={})
        with patch.dict(local_base._RUNS, {"dispatch-one": run}, clear=True):
            dispatched = self.environment()
            models = Path(dispatched["PI_CODING_AGENT_DIR"]) / "models.json"
            original = models.read_bytes()
            inherited = {**self.parent_environment, "SODUWORK_LLM_KEY": "stale-private-key"}
            with patch.dict(os.environ, inherited, clear=True):
                recovered = runner_environment("task", "dispatch-one", "pi")
        for key in ("PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR"):
            self.assertEqual(recovered[key], dispatched[key])
        self.assertNotIn("SODUWORK_LLM_KEY", recovered)
        self.assertEqual(models.read_bytes(), original)
        self.assertEqual((Path(recovered["PI_CODING_AGENT_SESSION_DIR"]) / source.name).read_bytes(),
                         source.read_bytes())

    def test_recovered_terminal_imports_only_owned_history_without_publishing_models(self):
        from app.services.terminal_environment import runner_environment
        source, run = self.historical_session()
        run.update(taskId="task", cli="pi", cfg={})
        with patch.dict(local_base._RUNS, {"dispatch-one": run}, clear=True), \
             patch.dict(os.environ, self.parent_environment, clear=True):
            recovered = runner_environment("task", "dispatch-one", "pi")
        directory = Path(recovered["PI_CODING_AGENT_DIR"])
        self.assertFalse((directory / "models.json").exists())
        self.assertEqual((directory / "sessions" / source.name).read_bytes(), source.read_bytes())
        self.assertNotIn("SODUWORK_LLM_KEY", recovered)

    def test_recovered_terminal_rejects_foreign_session_instead_of_personal_fallback(self):
        from app.services.terminal_environment import runner_environment
        source, run = self.historical_session(owner=False)
        run.update(taskId="task", cli="pi", cfg={})
        with patch.dict(local_base._RUNS, {"dispatch-one": run}, clear=True), \
             patch.dict(os.environ, self.parent_environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "原执行会话无法安全恢复"):
                runner_environment("task", "dispatch-one", "pi")
        self.assertTrue(source.exists())


if __name__ == "__main__":
    unittest.main()
