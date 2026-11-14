"""Device-owned automation stores only a source marker at the Hub boundary."""
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from app import models
from app.agent_catalog import AGENTS
from app.api.schedule_contract import apply_schedule_update, schedule_payload

from app.services.schedule_execution import (
    _schedule_model_readiness,
    validate_selected_model,
)


class ScheduleLocalModelTests(unittest.IsolatedAsyncioTestCase):
    async def test_device_source_is_ready_on_every_managed_runtime_without_hub_catalog(self):
        for agent, spec in AGENTS.items():
            if spec.get("modelMode") != "managed":
                continue
            with self.subTest(agent=agent):
                schedule = models.AiSchedule(title="automation", assignee_id="local:" + agent)
                apply_schedule_update(schedule, {"modelSource": "device"})
                with patch("app.services.model_catalog.choices", new=AsyncMock()) as catalog:
                    await validate_selected_model(None, schedule)
                    result = await _schedule_model_readiness(
                        None, None, {}, schedule.assignee_id, schedule.model_name)
                self.assertTrue(result["ok"])
                self.assertEqual(result["model"], "")
                self.assertEqual(schedule.model_source, "device")
                self.assertEqual(schedule.model_name, "")
                catalog.assert_not_called()

    async def test_legacy_opaque_reference_becomes_source_marker_before_save(self):
        model = "local:model-" + "a" * 32
        for agent, spec in AGENTS.items():
            if spec.get("modelMode") != "managed":
                continue
            with self.subTest(agent=agent):
                schedule = models.AiSchedule(title="automation", assignee_id="local:" + agent)
                apply_schedule_update(schedule, {"modelName": model})
                await validate_selected_model(None, schedule)
                payload = schedule_payload(schedule, timestamp=lambda value: None)
                self.assertEqual(payload["modelSource"], "device")
                self.assertEqual(payload["modelName"], "")
                self.assertNotIn(model, str(payload))

    async def test_readiness_rejects_private_references_without_echoing_them(self):
        for model in ("local:model-" + "b" * 32,
                      "image::device:provider::local:model-private"):
            for kind in ("local:pi", "local:qwen", "local:harness2", "local:codex"):
                with self.subTest(model=model, kind=kind), \
                        patch("app.services.model_catalog.choices", new=AsyncMock()) as catalog:
                    result = await _schedule_model_readiness(None, None, {}, kind, model)
                    self.assertFalse(result["ok"])
                    self.assertEqual(result["model"], "")
                    self.assertNotIn(model, str(result))
                    catalog.assert_not_called()

    async def test_saved_schedule_cannot_bypass_source_contract_with_raw_private_name(self):
        for model in ("local:model-" + "c" * 32, "private-wire-model"):
            with self.subTest(model=model):
                schedule = SimpleNamespace(model_name=model, model_source="device",
                                           assignee_id="local:pi")
                with self.assertRaisesRegex(ValueError, "设备模型来源标记"):
                    await validate_selected_model(None, schedule)

    async def test_same_device_runner_supports_all_managed_runtimes(self):
        for agent, spec in AGENTS.items():
            if spec.get("modelMode") != "managed":
                continue
            with self.subTest(agent=agent):
                schedule = SimpleNamespace(model_source="device", model_name="",
                    assignee_id="runner:desktop:" + agent, owner_client_id="owner")
                with patch("app.services.runner_hub.get",
                           return_value=SimpleNamespace(client_id="owner")):
                    await validate_selected_model(None, schedule)
                with patch("app.services.runner_hub.get",
                           return_value=SimpleNamespace(client_id="other")):
                    with self.assertRaisesRegex(ValueError, "不能派往其他执行机"):
                        await validate_selected_model(None, schedule)

    async def test_account_runtimes_reject_device_source_even_with_blank_name(self):
        for agent in ("codex", "claude"):
            with self.subTest(agent=agent):
                schedule = models.AiSchedule(title="automation", assignee_id="local:" + agent)
                with self.assertRaises(HTTPException) as error:
                    apply_schedule_update(schedule, {"modelSource": "device"})
                self.assertEqual(error.exception.status_code, 400)
                schedule.model_source, schedule.model_name = "device", ""
                with self.assertRaisesRegex(ValueError, "托管型执行底座"):
                    await validate_selected_model(None, schedule)

    async def test_managed_catalog_models_retain_normal_validation(self):
        catalog = {"default": "hub-model", "list": ["image::device:provider::hub-image"]}
        with patch("app.services.model_catalog.choices", new=AsyncMock(return_value=catalog)):
            for model in ("hub-model", "image::device:provider::hub-image"):
                result = await _schedule_model_readiness(None, None, {}, "local:qwen", model)
                self.assertTrue(result["ok"])
                self.assertEqual(result["model"], model)
            removed = await _schedule_model_readiness(None, None, {}, "local:qwen", "removed-model")
            self.assertFalse(removed["ok"])
        with patch("app.services.model_catalog.choices", new=AsyncMock(side_effect=RuntimeError("offline"))), \
                patch("app.services.agent_route_selection.model_readiness", return_value={"ok": True}) as legacy:
            unavailable = await _schedule_model_readiness(None, None, {}, "local:qwen", "hub-model")
        self.assertFalse(unavailable["ok"])
        legacy.assert_not_called()


if __name__ == "__main__":
    unittest.main()
