"""Managed Qwen model capabilities, configuration isolation and policy retention."""
from concurrent.futures import ThreadPoolExecutor
import copy
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

from app.services import acp_agents, local_base, qwen_runtime


class QwenRuntimeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-qwen-model-")
        self.addCleanup(self.temp.cleanup)
        # Windows TEMP can use an 8.3 alias; compare canonical ownership paths.
        self.root = Path(self.temp.name).resolve()
        self.operator = self.root / "operator.json"
        self.llm = {"base": "https://gateway.invalid/v1", "key": "private-model-ticket",
                    "model": "GLM5.3flash", "input": ["text", "image"]}

    def configure(self, llm=None, ref="conversation", root=None):
        env = {qwen_runtime.SETTINGS_ENV: str(self.operator)}
        acp_agents.inject_llm_env("qwen", env, self.llm if llm is None else llm)
        acp_agents.home_env("qwen", env, str(root or self.root))
        original_home = env["QWEN_HOME"]
        qwen_runtime.configure(env, self.llm if llm is None else llm, str(root or self.root), ref)
        self.assertEqual(env["QWEN_HOME"], original_home)
        config = json.loads(Path(env[qwen_runtime.SETTINGS_ENV]).read_text(encoding="utf-8"))
        return env, config

    def assert_image(self, config, expected):
        self.assertIs(config["model"]["generationConfig"]["modalities"]["image"], expected)
        provider = config["modelProviders"]["openai"][0]
        self.assertIs(provider["generationConfig"]["modalities"]["image"], expected)
        self.assertTrue(provider["generationConfig"]["splitToolMedia"])

    def test_keyless_local_model_still_gets_a_private_overlay(self):
        env, config = self.configure({**self.llm, "key": "", "localOnly": True})
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertEqual(config["model"]["name"], self.llm["model"])
        self.assertTrue(Path(env[qwen_runtime.SETTINGS_ENV]).is_relative_to(self.root))

    def test_alias_and_credentials_preserved_without_name_inference(self):
        env, config = self.configure()
        self.assert_image(config, True)
        provider = config["modelProviders"]["openai"][0]
        self.assertEqual(provider["id"], "GLM5.3flash")
        self.assertEqual(config["model"]["name"], "GLM5.3flash")
        self.assertEqual(config["model"]["baseUrl"], "$OPENAI_BASE_URL")
        self.assertEqual(provider["wireApi"], "chat-completions")
        self.assertEqual(provider["envKey"], "OPENAI_API_KEY")
        self.assertEqual(provider["baseUrl"], "$OPENAI_BASE_URL")
        self.assertEqual(env["OPENAI_API_KEY"], self.llm["key"])
        self.assertNotIn(self.llm["key"], json.dumps(config))
        self.assertNotIn(self.llm["base"], json.dumps(config))

    def test_native_text_unknown_and_authorized_fallback_routes(self):
        cases = [({}, False), ({"input": ["text"]}, False),
                 ({"imageRouting": "native"}, True),
                 ({"input": ["text", "image"]}, True),
                 ({"imageRouting": "vision-fallback", "visionFallbackAvailable": True}, False),
                 ({"base": "https://hub.invalid/api/v1/ai-proxy/v1",
                   "imageRouting": "vision-fallback", "visionFallbackAvailable": True}, True),
                 ({"base": "https://hub.invalid/api/v1/ai-proxy/v1",
                   "imageRouting": "vision-fallback", "visionFallbackAvailable": False}, False)]
        for fields, expected in cases:
            llm = {key: value for key, value in self.llm.items() if key != "input"}
            llm.update(fields)
            with self.subTest(fields=fields):
                _, config = self.configure(llm)
                self.assert_image(config, expected)

    def test_model_switch_and_parallel_sessions_do_not_rewrite_live_configs(self):
        def start(index):
            llm = {**self.llm, "model": f"alias-{index}", "input": ["text", "image"] if index % 2 else ["text"]}
            return self.configure(llm, ref="same-session" if index < 2 else f"session-{index}")
        with ThreadPoolExecutor(max_workers=4) as pool:
            rows = list(pool.map(start, range(8)))
        self.assertEqual(len({env[qwen_runtime.SETTINGS_ENV] for env, _ in rows}), 8)
        for index, (env, config) in enumerate(rows):
            self.assertEqual(json.loads(Path(env[qwen_runtime.SETTINGS_ENV]).read_text(encoding="utf-8")), config)
            self.assertEqual(config["modelProviders"]["openai"][0]["id"], f"alias-{index}")
            self.assert_image(config, bool(index % 2))

    def test_preserves_operator_permissions_comments_and_other_models(self):
        operator = {"permissions": {"deny": ["Shell(rm *)"], "ask": ["Write"]},
                    "tools": {"executionSandbox": {"enabled": True}},
                    "model": {"generationConfig": {"timeout": 45000}},
                    "modelProviders": {"openai": [
                        {"id": self.llm["model"], "apiKey": "stale-key", "generationConfig": {
                            "modalities": {"image": False, "pdf": True}, "samplingParams": {"temperature": 0.1}}},
                        {"id": "unrelated", "envKey": "OTHER_KEY", "baseUrl": "https://other.invalid/v1"}]}}
        original = "\ufeff// operator policy\n/* kept */" + json.dumps(operator)
        self.operator.write_text(original, encoding="utf-8")
        _, config = self.configure()
        self.assertEqual(self.operator.read_text(encoding="utf-8"), original)
        self.assertEqual(config["permissions"], operator["permissions"])
        self.assertEqual(config["tools"], operator["tools"])
        self.assertEqual(config["modelProviders"]["openai"][1], operator["modelProviders"]["openai"][1])
        generation = config["modelProviders"]["openai"][0]["generationConfig"]
        self.assertEqual(generation["samplingParams"], {"temperature": 0.1})
        self.assertTrue(generation["modalities"]["pdf"])
        self.assert_image(config, True)
        self.assertNotIn("stale-key", json.dumps(config))

    def test_comment_markers_inside_strings_are_not_stripped(self):
        operator = {"url": "https://example.invalid/a//b", "pattern": "Read(/*)", "text": 'a\\b"//c'}
        self.operator.write_text(json.dumps(operator), encoding="utf-8")
        _, config = self.configure()
        for key, value in operator.items():
            self.assertEqual(config[key], value)

    def test_user_model_registry_is_preserved_without_promoting_user_policy(self):
        native_home = self.root / ".qwen"
        native_home.mkdir()
        user = {"permissions": {"allow": ["Shell(*)"]}, "hooks": {"unsafe": []},
                "modelProviders": {"custom": [{"id": "other"}], "openai": [{
                    "id": self.llm["model"], "baseUrl": "$OPENAI_BASE_URL", "wireApi": "responses",
                    "generationConfig": {"samplingParams": {"temperature": 0.37}}}]}}
        (native_home / "settings.json").write_text(json.dumps(user), encoding="utf-8")
        self.operator.write_text(json.dumps({"permissions": {"deny": ["Write"]}}), encoding="utf-8")
        env, config = self.configure()
        self.assertEqual(config["permissions"], {"deny": ["Write"]})
        self.assertNotIn("hooks", config)
        self.assertEqual(config["modelProviders"]["custom"], user["modelProviders"]["custom"])
        self.assertEqual(next(iter(config["modelProviders"])), "openai")
        provider = config["modelProviders"]["openai"][0]
        self.assertEqual(provider["wireApi"], "responses")
        self.assertEqual(provider["generationConfig"]["samplingParams"], {"temperature": 0.37})
        self.assertEqual(env[qwen_runtime.DEFAULTS_ENV], str(self.root / "system-defaults.json"))
        self.assertEqual(json.loads((native_home / "settings.json").read_text()), user)

    def test_original_defaults_path_and_registry_scope_precedence_are_retained(self):
        defaults = self.root / "custom-defaults.json"
        defaults.write_text(json.dumps({"modelProviders": {"openai": [{"id": "default-model"}]}}))
        env = {qwen_runtime.SETTINGS_ENV: str(self.operator), qwen_runtime.DEFAULTS_ENV: str(defaults)}
        qwen_runtime.configure(env, self.llm, str(self.root))
        config = json.loads(Path(env[qwen_runtime.SETTINGS_ENV]).read_text())
        self.assertEqual(env[qwen_runtime.DEFAULTS_ENV], str(defaults))
        self.assertEqual(config["modelProviders"]["openai"][1]["id"], "default-model")
        self.operator.write_text('{"modelProviders":{}}')
        env = {qwen_runtime.SETTINGS_ENV: str(self.operator), qwen_runtime.DEFAULTS_ENV: str(defaults)}
        qwen_runtime.configure(env, self.llm, str(self.root))
        config = json.loads(Path(env[qwen_runtime.SETTINGS_ENV]).read_text())
        self.assertEqual(len(config["modelProviders"]["openai"]), 1)

    def test_same_name_other_endpoints_and_native_protocol_are_preserved(self):
        operator = {"modelProviders": {"openai": [
            {"id": self.llm["model"], "baseUrl": "https://other.invalid/v1", "wireApi": "responses"},
            {"id": self.llm["model"], "baseUrl": self.llm["base"], "wireApi": "responses"}]}}
        config = qwen_runtime.settings(self.llm, operator)
        self.assert_image(config, True)
        self.assertEqual(config["modelProviders"]["openai"][0]["wireApi"], "responses")
        self.assertEqual(config["modelProviders"]["openai"][1], operator["modelProviders"]["openai"][0])

    def test_malformed_operator_settings_fail_without_discarding_policy(self):
        for raw in ('{"private-model-ticket":', '[]', '{"model":null}',
                    '{"modelProviders":{"openai":"bad"}}', '{"a":1,}'):
            with self.subTest(raw=raw):
                self.operator.write_text(raw, encoding="utf-8")
                with self.assertRaises(RuntimeError) as caught:
                    self.configure()
                self.assertNotIn("private-model-ticket", str(caught.exception))

    def test_default_operator_locations_are_platform_specific(self):
        for platform, expected in (("win32", r"C:\ProgramData\qwen-code\settings.json"),
                                   ("darwin", "/Library/Application Support/QwenCode/settings.json"),
                                   ("linux", "/etc/qwen-code/settings.json")):
            with self.subTest(platform=platform), patch.object(qwen_runtime.sys, "platform", platform):
                self.assertEqual(str(qwen_runtime.system_settings_path({})), str(Path(expected)))

    def test_separate_runner_roots_never_share_generated_configuration(self):
        first, _ = self.configure(root=self.root / "development")
        second, _ = self.configure(root=self.root / "installed")
        self.assertNotEqual(first["QWEN_HOME"], second["QWEN_HOME"])
        self.assertTrue(Path(first[qwen_runtime.SETTINGS_ENV]).is_relative_to(self.root / "development"))
        self.assertTrue(Path(second[qwen_runtime.SETTINGS_ENV]).is_relative_to(self.root / "installed"))

    def test_unwritable_config_fails_before_environment_changes(self):
        env = {qwen_runtime.SETTINGS_ENV: str(self.operator)}
        original = dict(env)
        with patch.object(qwen_runtime.tempfile, "NamedTemporaryFile", side_effect=PermissionError("private path")):
            with self.assertRaises(RuntimeError) as caught:
                qwen_runtime.configure(env, self.llm, str(self.root), "fixture")
        self.assertEqual(env, original)
        self.assertNotIn("private path", str(caught.exception))

    def test_runtime_environment_uses_capabilities_and_preserves_native_home(self):
        with patch.dict(os.environ, {qwen_runtime.SETTINGS_ENV: str(self.operator)}), \
                patch.object(local_base, "_data_root", return_value=str(self.root)):
            env = local_base._env_for(local_base._PROFILES["qwen"], {"llm": self.llm}, "fixture-run")
        config = json.loads(Path(env[qwen_runtime.SETTINGS_ENV]).read_text(encoding="utf-8"))
        self.assert_image(config, True)
        self.assertEqual(env["OPENAI_MODEL"], self.llm["model"])
        self.assertEqual(Path(env["QWEN_HOME"]), self.root / ".qwen")

    def test_other_acp_agents_do_not_create_qwen_settings(self):
        with patch.object(qwen_runtime, "configure") as configure, \
                patch.object(local_base, "_data_root", return_value=str(self.root)):
            local_base._env_for(local_base._PROFILES["codex-harness"], {"llm": self.llm}, "other-run")
        configure.assert_not_called()

    def test_restored_sessions_select_the_advertised_route_without_saving_defaults(self):
        client = Mock(session_id="existing-session")
        models = {"availableModels": [{"name": qwen_runtime.MODEL_LABEL, "modelId": "route:opaque-id"}]}
        with patch.dict(os.environ, {qwen_runtime.MODEL_LABEL_ENV: qwen_runtime.MODEL_LABEL}):
            qwen_runtime.apply_model(client, {"models": models, "configOptions": [{"id": "model"}]})
            client.request.assert_called_once_with("session/set_config_option", {
                "sessionId": "existing-session", "configId": "model", "value": "route:opaque-id"})
            client.reset_mock()
            qwen_runtime.apply_model(client, {"models": models})
            client.request.assert_called_once_with("session/set_model", {
                "sessionId": "existing-session", "modelId": "route:opaque-id",
                "_meta": {"qwen.session.modelPersistDefault": False}})

    def test_missing_or_ambiguous_native_routes_fail_before_prompting(self):
        client = Mock()
        with patch.dict(os.environ, {qwen_runtime.MODEL_LABEL_ENV: qwen_runtime.MODEL_LABEL}):
            for models in ([], [{"name": qwen_runtime.MODEL_LABEL, "modelId": "first"},
                                {"name": qwen_runtime.MODEL_LABEL, "modelId": "second"}]):
                with self.subTest(models=models), self.assertRaises(RuntimeError):
                    qwen_runtime.apply_model(client, {"models": {"availableModels": models}})
        client.request.assert_not_called()
        with patch.dict(os.environ, {qwen_runtime.MODEL_LABEL_ENV: ""}):
            qwen_runtime.apply_model(client, {})
        client.request.assert_not_called()

    def test_input_contract_is_not_mutated_and_missing_model_is_untouched(self):
        before = copy.deepcopy(self.llm)
        self.configure()
        self.assertEqual(self.llm, before)
        env = {"keep": "value"}
        qwen_runtime.configure(env, {}, str(self.root))
        self.assertEqual(env, {"keep": "value"})


if __name__ == "__main__":
    unittest.main()
