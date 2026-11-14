"""Native usage remains device-owned until a reportable funding receipt exists."""
import json
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

from app.services import local_base, local_stream, runner_usage_receipts


class RunnerUsageReceiptTests(unittest.TestCase):
    def test_unknown_legacy_model_identity_requires_positive_public_ownership(self):
        legacy = {"cli": "qwen", "model": "private-wire", "usage": {"total": 99}}
        raw = {"model": "private-wire", "error": "old private-wire diagnostic", "usage": {"total": 99}}
        self.assertTrue(runner_usage_receipts.private_model(legacy))
        projected = runner_usage_receipts.public_snapshot(raw, legacy)
        self.assertEqual(projected["model"], "")
        self.assertEqual(projected["usage"], {})
        self.assertNotIn("private-wire", json.dumps(projected))
        self.assertFalse(runner_usage_receipts.private_model({**legacy, "modelLocalOnly": False}))
        self.assertFalse(runner_usage_receipts.private_model({"cli": "codex", "model": "account-model"}))

    def test_mixed_calls_keep_funding_after_persistence(self):
        run = {"cli": "qwen", "cfg": {"llm": {"localOnly": True, "model": "private-wire"}},
               "model": "private-wire"}
        local_stream._accumulate_usage(run, {"input": 10, "output": 2})
        run["cfg"]["llm"] = {"model": "managed", "quotaVersion": 2,
                              "quotaUsageToken": "signed-managed", "quotaProvider": "hub-provider"}
        run["model"] = "managed"
        local_stream._accumulate_usage(run, {"input": 3, "output": 1})
        receipts = runner_usage_receipts.private_snapshot(run)
        self.assertEqual([row["usage"]["total"] for row in receipts], [12, 4])
        self.assertEqual(receipts[0]["model"], "")
        self.assertFalse(receipts[0]["reportable"])
        self.assertEqual(receipts[1]["quotaUsageToken"], "signed-managed")
        self.assertEqual(runner_usage_receipts.public_usage(run)["total_tokens"], 4)
        self.assertNotIn("private-wire", json.dumps(receipts))
        self.assertNotIn("signed-managed", json.dumps(runner_usage_receipts.public_usage(run)))
        with tempfile.TemporaryDirectory() as root, patch.object(local_base, "_STORE", root), \
                patch.dict(local_base._RUNS, {"fixture": run}):
            local_base._save_meta("fixture")
            restored = json.loads((Path(root) / "fixture" / "meta.json").read_text())
            self.assertEqual(runner_usage_receipts.private_snapshot(restored), receipts)
            self.assertEqual(runner_usage_receipts.public_usage(restored)["total_tokens"], 4)

    def test_legacy_unknown_totals_do_not_become_managed_receipts(self):
        run = {"cli": "kimi", "usage": {"total": 1000}, "usageReceipts": None,
               "cfg": {"llm": {"model": "managed"}}}
        self.assertEqual(runner_usage_receipts.private_snapshot(run), [])
        self.assertEqual(runner_usage_receipts.public_usage(run), {})
        local_stream._accumulate_usage(run, {"input": 2, "output": 1})
        self.assertEqual(run["usage"]["total"], 1003)
        self.assertEqual(runner_usage_receipts.public_usage(run)["total_tokens"], 3)

    def test_queued_model_cannot_reassign_active_or_recovered_usage(self):
        run = {"cli": "qwen", "cfg": {"llm": {"model": "private-wire", "localOnly": True}}}
        runner_usage_receipts.capture(run, run["cfg"])
        run["cfg"] = {"llm": {"model": "future-managed", "quotaVersion": 2,
                                "quotaUsageToken": "future-token"}}
        local_stream._accumulate_usage(run, {"input": 8, "output": 1})
        self.assertFalse(run["usageReceipts"][-1]["reportable"])
        self.assertNotIn("quotaUsageToken", run["usageReceipts"][-1])
        recovered = json.loads(json.dumps({key: run.get(key) for key in local_base._PERSIST_KEYS}))
        local_stream._accumulate_usage(recovered, {"input": 2, "output": 1})
        self.assertFalse(recovered["usageReceipts"][-1]["reportable"])
        self.assertTrue(runner_usage_receipts.sanitize_event(recovered, {"kind": "usage"})["localModelMetadata"])

    def test_public_usage_retains_cache_and_unknown_cost_semantics(self):
        from app.services.usage_values import normalize_usage
        run = {"usageReceipts": [{"usage": {"input": 10, "output": 2, "cacheRead": 4,
                "inputIncludesCache": True, "costKnown": False}},
                {"usage": {"input": 3, "output": 1, "cacheRead": 2,
                "inputIncludesCache": False, "cost": 0}}]}
        projected = runner_usage_receipts.public_usage(run)
        self.assertTrue(projected["input_includes_cache"])
        self.assertFalse(projected["cost_known"])
        normalized = normalize_usage(projected)
        self.assertEqual(normalized["input_tokens"], 15)
        self.assertEqual(normalized["total_tokens"], 18)
        self.assertEqual(normalized["cache_read_tokens"], 6)
        self.assertFalse(normalized["cost_known"])

    def test_device_funding_cannot_inherit_previous_token(self):
        run = {"cli": "opencode", "cfg": {"llm": {"model": "private-wire", "localOnly": True,
               "quotaVersion": 2, "quotaUsageToken": "previous-token", "quotaProvider": "provider"}}}
        local_stream._accumulate_usage(run, {"input": 2, "output": 1})
        self.assertNotIn("quotaUsageToken", runner_usage_receipts.private_snapshot(run)[0])
        self.assertEqual(runner_usage_receipts.public_usage(run), {})

    def test_provider_error_is_sanitized_before_native_archive(self):
        run = {"cli": "qwen", "seq": 0, "segment": 1, "metaAt": time.time(),
               "cfg": {"llm": {"model": "private-wire", "localOnly": True,
                                "base": "http://private-model.invalid/v1", "key": "fixture-secret"}}}
        with tempfile.TemporaryDirectory() as root, patch.object(local_base, "_STORE", root), \
                patch.dict(local_base._RUNS, {"fixture": run}):
            local_stream._on_line("fixture", json.dumps({"type": "error", "message":
                "provider echoed http://private-model.invalid/v1 private-wire fixture-secret"}), {})
            row = run["lines"][-1]
            self.assertTrue(row["localModelMetadata"])
            self.assertIn("Local model request failed", row["text"])
            self.assertNotIn("private-wire", json.dumps(row))
            self.assertNotIn("fixture-secret", json.dumps(row))
            archived = (Path(root) / "fixture" / "events.jsonl").read_text()
            self.assertNotIn("private-model.invalid", archived)
        normal = {"kind": "say", "text": "A regular response about the user's work."}
        self.assertEqual(runner_usage_receipts.sanitize_event(run, normal)["text"], normal["text"])
        warning = {"kind": "out", "tool": "", "text": "Warning: private-wire metadata is unavailable"}
        self.assertEqual(runner_usage_receipts.sanitize_event(run, warning)["text"],
                         "Warning: [local model] metadata is unavailable")

    def test_remote_projection_removes_local_model_and_per_event_usage(self):
        run = {"modelLocalOnly": True, "usageReceipts": [
            {"localOnly": True, "reportable": False, "usage": {"total": 99}}]}
        raw = {"model": "private-wire", "tokens": {"input": 99}, "usage": {"total": 99},
               "activeExecutionSelection": {"agentId": "qwen", "modelName": "private-wire"},
               "usageReceipts": [{"quotaUsageToken": "private-ticket"}],
               "items": [{"seq": 1, "kind": "usage", "localModelMetadata": True,
                          "usage": {"total": 99},
                          "_terminal": {"result": "private-wire private-ticket http://private.invalid"}}]}
        public = runner_usage_receipts.public_snapshot(raw, run)
        self.assertEqual(public["usage"], {})
        self.assertEqual(public["tokens"], {})
        self.assertEqual(public["activeExecutionSelection"]["modelName"], "")
        self.assertEqual(public["items"], [{"seq": 1, "kind": "usage"}])
        self.assertNotIn("private-wire", json.dumps(public))
        self.assertNotIn("private-ticket", json.dumps(public))
        self.assertEqual(raw["model"], "private-wire")

    def test_legacy_private_events_drop_usage_without_changing_user_content(self):
        content = {"model": "user-written-model", "usage": {"units": 42}}
        raw = {"usage": {"total": 99}, "items": [
            {"seq": 1, "kind": "usage", "usage": {"total": 99}, "tokens": {"input": 99}},
            {"seq": 2, "kind": "say", "text": "User-visible model and usage discussion", "arguments": content},
        ]}
        for run in ({"cli": "qwen", "model": "unknown-wire"}, {"modelLocalOnly": True}):
            with self.subTest(run=run):
                projected = runner_usage_receipts.public_snapshot(raw, run)
                self.assertNotIn("usage", projected["items"][0])
                self.assertNotIn("tokens", projected["items"][0])
                self.assertEqual(projected["items"][1]["text"], raw["items"][1]["text"])
                self.assertEqual(projected["items"][1]["arguments"], content)
        managed = {"modelLocalOnly": False, "usageReceipts": [{"localOnly": False,
                   "reportable": True, "usage": {"input": 7, "output": 2}}]}
        projected = runner_usage_receipts.public_snapshot(raw, managed)
        self.assertEqual(projected["items"][0], raw["items"][0])
        self.assertEqual(projected["usage"]["total_tokens"], 9)


if __name__ == "__main__":
    unittest.main()
