"""Protect local model references in remote Runner acknowledgements."""
import unittest
from importlib import import_module
from types import SimpleNamespace
from unittest.mock import patch

from app.services import ai_remote
from app.services.ai_remote import _redact_local_model_fields
from app.services.model_reference_privacy import is_local_model_reference


class RemoteLocalModelPrivacyTests(unittest.TestCase):
    def test_image_references_allow_namespaced_providers_without_widening_model_detection(self):
        migration_reference = import_module("migrations.versions.0089_schedule_model_source")._local_reference
        for value in ("image::device:provider::local:model-private",
                      " image:: device:provider :: local:model-private \n",
                      "local:model-private", " image::provider::\tlocal:model-private "):
            with self.subTest(value=value):
                self.assertTrue(is_local_model_reference(value))
                self.assertTrue(migration_reference(value))
        for value in ("image::device:provider::hub-model", "image::local:provider::hub-model",
                      "image::::local:model-private", "image::   ::local:model-private",
                      "image::device:provider", "image::device:provider::not-local:model-private",
                      "image::device:provider::vendor/local:model-private",
                      "image::device:provider::Local:model-private", "managed::local:model-private"):
            with self.subTest(value=value):
                self.assertFalse(is_local_model_reference(value))
                self.assertFalse(migration_reference(value))

    def test_redacts_model_references_recursively(self):
        payload = {
            "model": "local:secret-model",
            "selection": {"agentId": "pi", "modelName": "secret-wire-model"},
            "contextReport": {"modelRef": "local:opaque-ref", "nested": [{"modelId": "x"}]},
            "pluginSnapshot": {"name": "plugin", "version": "1"},
            "runnerId": "desktop",
        }

        result = _redact_local_model_fields(payload)

        self.assertEqual(result["model"], "")
        self.assertEqual(result["selection"]["modelName"], "")
        self.assertEqual(result["contextReport"], {
            "modelRef": "",
            "nested": [{"modelId": ""}],
        })
        self.assertEqual(result["pluginSnapshot"], payload["pluginSnapshot"])
        self.assertEqual(result["runnerId"], "desktop")
        self.assertEqual(payload["model"], "local:secret-model")

    def test_remote_dispatch_rejects_local_model_before_uploading_or_reserving(self):
        runner = SimpleNamespace(
            id="desktop", agents=[{"key": "pi", "auth": "authed", "name": "Pi"}],
            version="1", host="desktop", client_id="client", boot_id="boot",
        )
        response = {
            "ok": True,
            "data": {
                "ref": "execution-ref",
                "identifier": "LOCAL-execution",
                "model": "wire-local-model",
                "selection": {"modelName": "wire-local-model"},
                "contextReport": {"modelRef": "local:opaque"},
                "state": "running",
            },
        }
        cfg = {"llm": {"base": "http://127.0.0.1:11434", "model": "local:opaque",
                        "localOnly": True}}
        task = SimpleNamespace(id="task", title="Local task", description="run")
        with patch.object(ai_remote.runner_hub, "get", return_value=runner), \
             patch.object(ai_remote.runner_hub, "can_dispatch", return_value=True), \
             patch.object(ai_remote, "personal_cloud_authorized", return_value=True), \
             patch.object(ai_remote.execution_capabilities, "required_for", return_value=[]), \
             patch.object(ai_remote.runner_hub, "capability_verdict", return_value={"ok": True}), \
             patch.object(ai_remote.runner_hub, "reserve_dispatch", return_value=(True, "token")) as reserve, \
             patch.object(ai_remote.runner_hub, "release_dispatch"), \
             patch.object(ai_remote, "_upload_inputs", return_value=({"items": []}, "")) as upload, \
             patch.object(ai_remote.runner_hub, "call_sync", return_value=response) as rpc:
            result = ai_remote.dispatch_sync(
                cfg, task, files=[],
                assignee={"id": "runner:desktop:pi",
                          "selection": {"modelName": "wire-local-model"}}, ctx={})

        self.assertFalse(result["ok"])
        self.assertEqual(result["code"], "LOCAL_MODEL_REMOTE_FORBIDDEN")
        reserve.assert_not_called()
        upload.assert_not_called()
        rpc.assert_not_called()

    def test_remote_dispatch_rejects_local_references_in_nested_context_and_selection(self):
        for cfg, assignee, ctx in (
            ({"llm": {"model": "local:opaque"}}, {}, {}),
            ({}, {"selection": {"modelName": "local:opaque"}}, {}),
            ({}, {}, {"localCfg": {"llm": {"model": "wire", "localOnly": True}}}),
            ({}, {}, {"cfg": {"llm": {"model": "image::private::local:opaque"}}}),
            ({}, {}, {"cfg": {"llm": {"model": "image::device:provider::local:opaque"}}}),
        ):
            with self.subTest(cfg=cfg, assignee=assignee, ctx=ctx), \
                    patch.object(ai_remote.runner_hub, "call_sync") as rpc:
                result = ai_remote.dispatch_sync(cfg, SimpleNamespace(id="task"),
                    assignee=assignee, ctx=ctx)
                self.assertEqual(result["code"], "LOCAL_MODEL_REMOTE_FORBIDDEN")
                rpc.assert_not_called()


if __name__ == "__main__":
    unittest.main()
