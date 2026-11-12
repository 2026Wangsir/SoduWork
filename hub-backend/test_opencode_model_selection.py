"""Managed OpenCode turns select their current route before sending any prompt."""
import json
import os
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

from app.services import acp_bridge, local_base, opencode_model_selection as selection, runner_sources


class OpenCodeModelSelectionTests(unittest.TestCase):
    def setUp(self):
        config = {"model": "company/replacement", "provider": {"company": {
            "models": {"replacement": {}}, "options": {"apiKey": "{env:SODUWORK_LLM_KEY}"}}}}
        self.environment = patch.dict(os.environ, {"OPENCODE_CONFIG_CONTENT": json.dumps(config)}, clear=True)
        self.environment.start()
        self.addCleanup(self.environment.stop)
        self.option = {"id": "model", "type": "select", "currentValue": "company/original",
                       "options": [{"value": "company/replacement", "name": "Managed model"}]}
        self.client = SimpleNamespace(session_id="ses_owned", request=Mock(return_value={
            "configOptions": [{**self.option, "currentValue": "company/replacement"}]}))

    def test_native_start_and_resume_pin_selected_route_without_changing_session(self):
        profile = local_base._PROFILES["opencode"]
        cfg = {"llm": {"model": "provider/model-name", "key": "fixture-private-key"}}
        for action in ("start", "resume"):
            args = profile[action]("ses_owned", "work", "/work", cfg)
            self.assertEqual(args[args.index("--model") + 1], "company/provider/model-name")
            self.assertNotIn("fixture-private-key", args)
            if action == "resume":
                self.assertEqual(args[args.index("--session") + 1], "ses_owned")
        self.assertEqual(selection.native_arguments({}), [])

    def test_config_option_changes_current_route_before_prompt(self):
        selection.apply_model(self.client, {"configOptions": [self.option]})
        self.client.request.assert_called_once_with("session/set_config_option", {
            "sessionId": "ses_owned", "configId": "model", "value": "company/replacement"})

    def test_grouped_advertised_routes_are_supported(self):
        option = {**self.option, "options": [{"group": "company", "options": self.option["options"]}]}
        selection.apply_model(self.client, {"configOptions": [option]})
        self.client.request.assert_called_once()

    def test_already_selected_route_does_not_change_session(self):
        selection.apply_model(self.client, {"configOptions": [{**self.option, "currentValue": "company/replacement"}]})
        self.client.request.assert_not_called()

    def test_missing_duplicate_or_unadvertised_model_fails_closed(self):
        for options in ([], [self.option, self.option], [{**self.option, "options": []}],
                        [{**self.option, "options": [{"name": "company/replacement", "value": "different"}]}]):
            with self.subTest(options=options), self.assertRaisesRegex(RuntimeError, "未提供"):
                selection.apply_model(self.client, {"configOptions": options})
        self.client.request.assert_not_called()

    def test_unconfirmed_change_does_not_retry_or_fall_back(self):
        for result in ({}, {"configOptions": [self.option]}):
            self.client.request.reset_mock()
            self.client.request.return_value = result
            with self.subTest(result=result), self.assertRaisesRegex(RuntimeError, "未确认"):
                selection.apply_model(self.client, {"configOptions": [self.option]})
            self.client.request.assert_called_once()

    def test_rpc_failure_does_not_select_another_model(self):
        self.client.request.side_effect = acp_bridge.BridgeError("Fixture refusal")
        with self.assertRaisesRegex(acp_bridge.BridgeError, "Fixture refusal"):
            selection.apply_model(self.client, {"configOptions": [self.option]})
        self.client.request.assert_called_once()

    def test_bridge_never_prompts_after_unconfirmed_selection(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-opencode-selection-") as directory:
            bridge = acp_bridge.AcpBridge([], directory, "opencode", "workspace", "ses_owned")
            def response(method, _params):
                if method == "initialize":
                    return {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}}
                if method == "session/load":
                    return {"configOptions": [self.option]}
                if method == "session/set_config_option":
                    return {}
                self.fail("Unexpected request: " + method)
            with patch.object(bridge, "start"), patch.object(bridge, "request", side_effect=response) as request, \
                 patch.object(bridge.access, "apply") as access:
                with self.assertRaisesRegex(acp_bridge.BridgeError, "未确认"):
                    bridge.run("Fixture prompt")
            self.assertEqual([call.args[0] for call in request.call_args_list],
                             ["initialize", "session/load", "session/set_config_option"])
            access.assert_not_called()

    def test_legacy_model_advertisement_uses_exact_route(self):
        selection.apply_model(self.client, {"models": {"currentModelId": "company/original",
            "availableModels": [{"modelId": "company/replacement", "name": "Different display name"}]}})
        self.client.request.assert_called_once_with("session/set_model", {
            "sessionId": "ses_owned", "modelId": "company/replacement"})

    def test_unmanaged_agent_does_not_get_a_managed_model(self):
        for content in ("", '{"model":"native/model"}'):
            with patch.dict(os.environ, {"OPENCODE_CONFIG_CONTENT": content}):
                selection.apply_model(self.client, {})
        self.client.request.assert_not_called()

    def test_invalid_managed_configuration_does_not_leak_content(self):
        for content in ('invalid PRIVATE-FIXTURE', '[]', '{"provider":{"company":{}}}',
                        '{"provider":{"company":{"models":{}}},"model":"company/missing"}'):
            with patch.dict(os.environ, {"OPENCODE_CONFIG_CONTENT": content}), \
                 self.subTest(content=content), self.assertRaisesRegex(RuntimeError, "模型配置无效") as raised:
                selection.apply_model(self.client, {})
            self.assertNotIn("PRIVATE-FIXTURE", str(raised.exception))
        self.client.request.assert_not_called()

    def test_shared_helper_is_in_runner_source_closure(self):
        backend = Path(__file__).resolve().parent
        self.assertIn(backend / "app/services/opencode_model_selection.py",
                      runner_sources.build_inputs(backend, backend.parent))


if __name__ == "__main__":
    unittest.main()
