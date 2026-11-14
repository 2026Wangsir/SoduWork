"""Rejected follow-ups retain transcript and fail without transport retries."""
from pathlib import Path
import tempfile
import sys
import unittest
from unittest.mock import patch

from app.services import ai_local, local_base, runner_admission as admission
from runner_main import Runner


class AdmissionHistoryTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="soduwork-admission-history-")
        self.addCleanup(self.temp.cleanup)
        self.runner = object.__new__(Runner)
        self.runner._admission = admission.AdmissionQueue()
        self.queue = self.runner._admission
        self.ref = "history-after-failed-followup"
        self.store = patch.object(local_base, "_STORE", self.temp.name)
        self.store.start()
        self.addCleanup(self.store.stop)
        self.addCleanup(local_base._RUNS.pop, self.ref, None)

    def refuse(self, state="failed", operation="comment"):
        item = self.queue.submit("turn-two", self.ref, admission.INTERACTIVE, operation, {})[2]
        self.queue.finish(item.key, state, "preflight refused" if state == "failed" else "")
        return item

    def archive(self):
        local_base._RUNS[self.ref] = {"cli": "codex", "cliSid": "native-acp-id", "state": "done",
            "ws": self.temp.name, "seq": 2, "segment": 1, "round": 1, "lines": [], "queue": [],
            "codexTransport": "account-acp-v1", "ended": 1, "executionStartedAt": 1730000000}
        local_base._save_meta(self.ref)
        target = Path(local_base._store_dir(self.ref), "events.jsonl")
        target.write_text('{"seq":1,"kind":"user","text":"first prompt"}\n'
                          '{"seq":2,"kind":"say","text":"saved answer"}\n', encoding="utf-8")
        local_base._RUNS.pop(self.ref)  # Reproduce actual process restart, not only warm memory.

    async def test_failed_followup_rehydrates_history_and_reports_terminal_outcome(self):
        self.archive()
        item = self.refuse()
        result = await self.runner._job({"op": "job.session", "ref": self.ref, "since": 0})
        data = result["data"]
        self.assertTrue(result["ok"] and data["ok"])
        self.assertEqual(data["status"], "failed")
        self.assertEqual(data["error"], "preflight refused")
        self.assertEqual([row["text"] for row in data["items"]], ["first prompt", "saved answer"])
        self.assertEqual(data["last"], 2)
        self.assertFalse(data["canStop"])
        self.assertEqual(data.get("executionStartedAt"), 0, "old turn history is not this turn's launch")
        self.assertEqual(self.queue.get(item.key).state, "failed")
        self.assertIsNone(self.queue.claim_next(0, 1, True), "reading history must never replay rejected work")
        next_page = await self.runner._job({"op": "job.session", "ref": self.ref, "since": 1})
        self.assertEqual([row["seq"] for row in next_page["data"]["items"]], [2])

    async def test_cancelled_followup_retains_history_without_changing_stop_outcome(self):
        self.archive()
        self.refuse("cancelled")
        result = await self.runner._job({"op": "job.session", "ref": self.ref})
        self.assertEqual(result["data"]["status"], "cancelled")
        self.assertEqual(len(result["data"]["items"]), 2)
        self.assertTrue(result["data"]["ok"])
        self.assertEqual(result["data"].get("executionStartedAt"), 0)

    async def test_failed_followup_native_history_keeps_local_model_metadata_private(self):
        self.archive()
        run = local_base.rehydrate(self.ref)
        run.update(model="private-wire", modelLocalOnly=True,
                   tokens={"input": 99}, usage={"input": 99},
                   usageReceipts=[{"localOnly": True, "reportable": False, "usage": {"input": 99}}])
        self.refuse()
        remote = await self.runner._job({"op": "job.session", "ref": self.ref})
        self.assertEqual(remote["data"]["model"], "")
        self.assertEqual(remote["data"]["activeExecutionSelection"]["modelName"], "")
        self.assertEqual(remote["data"]["tokens"], {})
        self.assertEqual(remote["data"]["usage"], {})
        self.assertEqual([row["text"] for row in remote["data"]["items"]], ["first prompt", "saved answer"])
        local = await self.runner._job({"op": "job.session", "ref": self.ref, "_localParent": True})
        self.assertEqual(local["data"]["model"], "private-wire")

    async def test_queued_and_preparing_followup_never_expose_the_previous_launch(self):
        self.archive()
        item = self.queue.submit("turn-two", self.ref, admission.INTERACTIVE, "comment", {})[2]
        for state in ("queued", "starting"):
            item.state = state
            result = await self.runner._job({"op": "job.session", "ref": self.ref})
            self.assertEqual(result["data"].get("executionStartedAt"), 0, state)

    async def test_refused_followup_cannot_reuse_a_warm_previous_turn_start_marker(self):
        for state in ("failed", "cancelled"):
            with self.subTest(state=state):
                self.archive()
                previous = local_base.rehydrate(self.ref)
                self.assertEqual(previous["executionStartedAt"], 1730000000)
                self.runner._admission = self.queue = admission.AdmissionQueue()
                self.refuse(state)
                result = await self.runner._job({"op": "job.session", "ref": self.ref})
                self.assertEqual(result["data"].get("executionStartedAt"), 0)

    async def test_native_new_round_clears_launch_before_preparation_and_spawn(self):
        from app.services import local_stream
        row = {"cli": "qwen", "cliSid": "old-session", "state": "done", "ws": self.temp.name,
            "cfg": {}, "queue": [], "round": 1, "seq": 2, "mode": "work", "lines": [],
            "executionStartedAt": 1730000000}
        local_base._RUNS[self.ref] = row
        seen = []
        def resolve_executable():
            seen.append(row["executionStartedAt"])
            return sys.executable
        with patch.dict(local_base._PROFILES["qwen"], {"bin": resolve_executable}), \
                patch.object(local_stream, "_spawn") as spawn:
            result = local_stream.comment_sync({}, self.ref, "new requirement")
        self.assertTrue(result["ok"], result)
        self.assertEqual(seen, [0], "heartbeat may read the running row before spawn")
        self.assertEqual(row["executionStartedAt"], 0)
        spawn.assert_called_once()

    async def test_failed_initial_dispatch_returns_successful_terminal_snapshot(self):
        self.refuse(operation="dispatch")
        with patch.object(ai_local, "session_sync") as native:
            result = await self.runner._job({"op": "job.session", "ref": self.ref})
        native.assert_not_called()
        self.assertTrue(result["data"]["ok"])
        self.assertEqual(result["data"]["status"], "failed")
        self.assertEqual(result["data"]["items"], [])


if __name__ == "__main__":
    unittest.main()
