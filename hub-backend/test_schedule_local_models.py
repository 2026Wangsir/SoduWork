"""Local model references are accepted only by the owning desktop Pi automation."""
import unittest
from types import SimpleNamespace

from app.services.schedule_execution import (
    _schedule_model_readiness,
    validate_selected_model,
)


class ScheduleLocalModelTests(unittest.IsolatedAsyncioTestCase):
    async def test_opaque_local_reference_is_ready_for_local_pi(self):
        model = "local:model-" + "a" * 32
        result = await _schedule_model_readiness(
            None, None, {}, "local:pi", model, allow_device_local=True)
        self.assertTrue(result["ok"])
        self.assertEqual(result["model"], model)

    async def test_opaque_local_reference_is_rejected_for_remote_runner(self):
        model = "local:model-" + "b" * 32
        result = await _schedule_model_readiness(
            None, None, {}, "local:pi", model, allow_device_local=False)
        self.assertFalse(result["ok"])

    async def test_saved_schedule_model_is_bound_to_local_pi(self):
        model = "local:model-" + "c" * 32
        await validate_selected_model(
            None, SimpleNamespace(model_name=model, assignee_id="local:pi"))
        with self.assertRaisesRegex(ValueError, "\u672c\u5730\u6a21\u578b"):
            await validate_selected_model(
                None, SimpleNamespace(model_name=model, assignee_id="runner:desk:pi"))


if __name__ == "__main__":
    unittest.main()
