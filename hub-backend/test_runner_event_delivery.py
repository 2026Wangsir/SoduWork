"""Durable transport fault tests with isolated disk, database and fake sockets."""
import asyncio
import contextvars
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from test_handoff_target_diagnostics import TargetDiagnosticsTests as _Base
from sqlalchemy import insert, select
from app import db, models
from app.automation_models import ExecutionEvent, ExecutionSession
from app.api import runner_ws
from app.services import execution_sessions, runner_event_delivery
from app.services.runner_event_outbox import Outbox, OutboxFull, snapshot_digest
import runner_main


class FixtureDependencyTests(unittest.TestCase):
    def test_default_fixture_drops_inherited_pythonpath(self):
        from e2e_cloud_durable_execution import _child_environment, _dependencies
        with patch.dict(os.environ, {"PYTHONPATH": "untrusted-inherited-packages"}, clear=True):
            self.assertEqual(_dependencies(), (None, {}))
            for role in ("hub", "runner"):
                self.assertNotIn("PYTHONPATH", _child_environment(Path("fixture"), role))

    def test_explicit_overlay_replaces_inherited_pythonpath_for_both_roles(self):
        import json
        from e2e_cloud_durable_execution import (
            DEPENDENCY_OVERLAY_ENV, EXPECTED_VERSIONS_ENV, _child_environment, _dependencies)
        expected = {"fastapi": "0.143.2", "starlette": "1.8.0", "pydantic": "2.13.5"}
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
                "PYTHONPATH": "untrusted-inherited-packages", DEPENDENCY_OVERLAY_ENV: directory,
                EXPECTED_VERSIONS_ENV: json.dumps(expected)}, clear=True):
            overlay, versions = _dependencies()
            self.assertEqual((overlay, versions), (Path(directory).resolve(), expected))
            for role in ("hub", "runner"):
                env = _child_environment(Path(directory), role, overlay)
                self.assertEqual(env["PYTHONPATH"], str(overlay))

    def test_invalid_overlay_and_incomplete_version_claims_fail_before_launch(self):
        from e2e_cloud_durable_execution import _dependencies
        expected = {"fastapi": "0.143.2", "starlette": "1.8.0", "pydantic": "2.13.5"}
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {}, clear=True):
            root = Path(directory)
            with self.assertRaises(FileNotFoundError):
                _dependencies(root / "missing", expected)
            file = root / "not-a-directory"
            file.write_text("fixture", encoding="utf-8")
            with self.assertRaises(ValueError):
                _dependencies(file, expected)
            for versions in ({}, {"fastapi": "0.143.2"}, {**expected, "pydantic": None}):
                with self.assertRaises(ValueError):
                    _dependencies(root, versions)

    def test_actual_child_versions_must_match_the_requested_stack(self):
        from e2e_cloud_durable_execution import _check_dependencies
        expected = {"fastapi": "0.143.2", "starlette": "1.8.0", "pydantic": "2.13.5"}
        _check_dependencies("hub", dict(expected), expected)
        _check_dependencies("runner", dict(expected), expected)
        for actual in (None, {**expected, "fastapi": "0.115.0"}):
            with self.assertRaisesRegex(AssertionError, "dependency mismatch"):
                _check_dependencies("hub", actual, expected)


def snapshot(ref="fixture-ref", task_id="fixture-task", seqs=(1,), *, round_no=1, state="running"):
    return {"ref": ref, "taskId": task_id, "round": round_no,
            "state": state, "seq": max(seqs, default=0),
            "items": [{"seq": seq, "kind": "text", "text": "fixture-event-%s" % seq,
                       "round": round_no} for seq in seqs]}


class OutboxTests(unittest.TestCase):
    def test_abrupt_process_exit_after_commit_preserves_unacknowledged_packet(self):
        with tempfile.TemporaryDirectory() as root:
            code = ("import os, sys; from app.services.runner_event_outbox import Outbox; "
                    "box=Outbox(sys.argv[1], 'fixture'); "
                    "box.append({'ref':'fixture-ref','taskId':'fixture-task','round':1,'seq':1,"
                    "'state':'done','items':[{'seq':1,'kind':'text','text':'fixture'}]},"
                    "('fixture-ref',1,'done')); os._exit(23)")
            process = subprocess.run([sys.executable, "-c", code, root], timeout=20,
                                     stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=os.environ.copy())
            self.assertEqual(process.returncode, 23, process.stderr)
            packet = Outbox(root, "fixture").pending()[0]
            self.assertEqual((packet["deliverySeq"], packet["snapshot"]["state"]), (1, "done"))

    def test_restart_replays_exact_packet_and_only_exact_ack_deletes(self):
        with tempfile.TemporaryDirectory() as root:
            first = Outbox(root, "fixture-hub|runner-a|device-a")
            first.append(snapshot(), ("fixture-ref", 1, "running"))
            packet = first.pending()[0]
            recovered = Outbox(root, "fixture-hub|runner-a|device-a")
            self.assertEqual(recovered.pending(), [packet])
            self.assertEqual(recovered.marks()["fixture-ref"], (1, "running"))
            self.assertFalse(recovered.acknowledge({**packet, "digest": "wrong"}))
            self.assertFalse(recovered.acknowledge({**packet, "streamId": "wrong"}))
            self.assertFalse(recovered.acknowledge({**packet, "deliverySeq": 99}))
            self.assertTrue(recovered.acknowledge(packet))
            self.assertFalse(recovered.acknowledge(packet))
            recovered.append(snapshot(seqs=(2,)), ("fixture-ref", 2, "done"))
            self.assertEqual(recovered.pending()[0]["deliverySeq"], 2)
            self.assertEqual(recovered.pending()[0]["streamId"], packet["streamId"])
            self.assertEqual(Outbox(root, "fixture-hub|runner-b|device-a").pending(), [])
            self.assertEqual(Outbox(root, "other-hub|runner-a|device-a").pending(), [])

    def test_capacity_never_advances_collection_cursor_or_discards_terminal_packet(self):
        with tempfile.TemporaryDirectory() as root:
            box = Outbox(root, "fixture", max_packets=1)
            box.append(snapshot(state="done"), ("fixture-ref", 1, "done"))
            with self.assertRaises(OutboxFull):
                box.append(snapshot(seqs=(2,)), ("fixture-ref", 2, "running"))
            self.assertEqual(box.marks()["fixture-ref"], (1, "done"))
            self.assertEqual(box.pending()[0]["snapshot"]["state"], "done")
            self.assertTrue(Outbox(root, "fixture", max_packets=1).at_capacity())
            box.acknowledge(box.pending()[0])
            self.assertFalse(box.at_capacity())

    def test_per_ref_order_is_contiguous_and_other_refs_are_not_starved(self):
        with tempfile.TemporaryDirectory() as root:
            box = Outbox(root, "fixture")
            box.append(snapshot(), ("fixture-ref", 1, "running"))
            box.append(snapshot(seqs=(2,)), ("fixture-ref", 2, "done"))
            box.append(snapshot(ref="second"), ("second", 1, "done"))
            self.assertEqual([(p["ref"], p["deliverySeq"]) for p in box.pending()],
                             [("fixture-ref", 1), ("second", 1)])

    def test_rejected_refs_do_not_starve_sessions_after_first_window(self):
        with tempfile.TemporaryDirectory() as root:
            box = Outbox(root, "fixture")
            for number in range(14):
                ref = "ref-%02d" % number
                box.append(snapshot(ref=ref), (ref, 1, "done"))
            first = box.pending()
            second = box.pending(after_ref=first[-1]["ref"])
            self.assertEqual([p["ref"] for p in second[:2]], ["ref-12", "ref-13"])


class DurableDeliveryTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = _Base.asyncSetUp
    asyncTearDown = _Base.asyncTearDown

    async def seed(self):
        self.tid, self.ref = self.prefix + "-task", self.prefix + "-ref"
        self.runner = SimpleNamespace(id=self.prefix + "-runner", boot_id="fixture-boot",
            client_id=self.client_id, org_id="", host="isolated", version="1.0", send=AsyncMock())
        async with db.SessionLocal() as session:
            session.add_all([
                models.Task(id=self.tid, title="Durable delivery fixture", status="doing",
                            owner_client_id=self.client_id),
                ExecutionSession(task_id=self.tid, ref=self.ref, runner_id=self.runner.id,
                                 runner_client_id=self.client_id, state="running", metadata_={"round": 1}),
                models.TaskEvent(task_id=self.tid, kind="ai.dispatched", actor="test",
                                 detail={"ref": self.ref, "runnerId": self.runner.id}),
            ])
            await session.commit()

    def message(self, sequence=1, seqs=(1,), *, round_no=1, state="running"):
        snap = snapshot(self.ref, self.tid, seqs, round_no=round_no, state=state)
        return {"op": "session.deliver", "version": 1, "runnerId": self.runner.id,
                "bootId": self.runner.boot_id, "ref": self.ref, "streamId": "a" * 32,
                "deliverySeq": sequence, "digest": snapshot_digest(snap), "snapshot": snap}

    async def accept(self, message):
        async with db.SessionLocal() as session:
            result = await runner_event_delivery.ingest(session, self.runner, message)
            await session.commit()
            return result

    async def stored(self):
        async with db.SessionLocal() as session:
            row = (await session.scalars(select(ExecutionSession).where(
                ExecutionSession.ref == self.ref))).one()
            events = (await session.scalars(select(ExecutionEvent).where(
                ExecutionEvent.session_id == row.id).order_by(ExecutionEvent.seq))).all()
            return row, events

    async def test_lost_ack_replays_once_and_does_not_repeat_execution_or_settlement(self):
        await self.seed()
        message = self.message()
        self.runner.send.side_effect = ConnectionError("fixture ACK lost")
        with patch.object(runner_ws, "_publish_session_updates", AsyncMock()) as publish:
            await runner_ws._ingest_delivery(self.runner, message)
            self.runner.send.side_effect = None
            await runner_ws._ingest_delivery(self.runner, message)
        row, events = await self.stored()
        self.assertEqual((row.delivery_seq, row.persisted_seq, len(events)), (1, 1, 1))
        self.assertEqual(publish.call_args.args[0], [])
        self.assertEqual(self.runner.send.call_args.args[0]["op"], "session.ack")

    async def test_commit_failure_does_not_ack_or_retain_partial_facts(self):
        await self.seed()
        factory = db.SessionLocal
        def failing_session():
            session = factory()
            session.commit = AsyncMock(side_effect=OSError("fixture commit failure"))
            return session
        with patch.object(runner_ws, "SessionLocal", failing_session):
            await runner_ws._ingest_delivery(self.runner, self.message())
        self.runner.send.assert_not_called()
        row, events = await self.stored()
        self.assertEqual((row.delivery_seq, len(events)), (0, 0))
        await self.accept(self.message())

    async def test_packet_ack_does_not_skip_event_gap_and_late_page_repairs_cursor(self):
        await self.seed()
        ack, _ = await self.accept(self.message(seqs=(1, 3)))
        self.assertEqual((ack["deliverySeq"], ack["persistedThrough"]), (1, 1))
        async with db.SessionLocal() as session:
            first = await execution_sessions.read_task(session, self.tid, self.ref, contiguous=True)
        self.assertEqual([e["seq"] for e in first["items"]], [1])
        self.assertEqual(first["historyGap"], {
            "expectedSeq": 2, "nextAvailableSeq": 3, "observedThrough": 3})
        self.assertFalse(first["hasMore"])
        async with db.SessionLocal() as session:
            legacy = await execution_sessions.read_task(session, self.tid, self.ref)
        self.assertEqual([e["seq"] for e in legacy["items"]], [1, 3])
        self.assertEqual((legacy["last"], legacy["persistedThrough"]), (3, 1))
        second = self.message(2, (2,))
        second["snapshot"]["seq"] = 3
        second["digest"] = snapshot_digest(second["snapshot"])
        ack, _ = await self.accept(second)
        self.assertEqual(ack["persistedThrough"], 3)
        async with db.SessionLocal() as session:
            page = await execution_sessions.read_task(session, self.tid, self.ref, since=1,
                                                      limit=1, contiguous=True)
        self.assertEqual((page["last"], page["hasMore"]), (2, True))
        self.assertIsNone(page["historyGap"])

    async def test_migrated_gapped_history_preserves_suffix_without_inventing_cursor(self):
        await self.seed()
        async with db.SessionLocal() as session:
            row = (await session.scalars(select(ExecutionSession).where(
                ExecutionSession.ref == self.ref))).one()
            row.seq = 5
            await session.execute(insert(ExecutionEvent), [
                {"session_id": row.id, "seq": seq, "kind": "text", "text": str(seq)}
                for seq in (2, 4)])
            await session.commit()
        async with db.SessionLocal() as session:
            legacy = await execution_sessions.read_task(session, self.tid, self.ref)
            page = await execution_sessions.read_task(session, self.tid, self.ref, contiguous=True)
            resumed = await execution_sessions.read_task(session, self.tid, self.ref,
                                                         since=4, contiguous=True)
            self.assertFalse(session.dirty)
        self.assertEqual([e["seq"] for e in legacy["items"]], [2, 4])
        self.assertEqual(legacy["last"], 4)
        self.assertEqual((page["items"], page["persistedThrough"], page["hasMore"]), ([], 0, False))
        self.assertEqual(page["historyGap"], {
            "expectedSeq": 1, "nextAvailableSeq": 2, "observedThrough": 5})
        self.assertEqual((resumed["last"], resumed["persistedThrough"]), (4, 0))

    async def test_migrated_history_replays_past_scan_page_without_requiring_read_commit(self):
        await self.seed()
        async with db.SessionLocal() as session:
            row = (await session.scalars(select(ExecutionSession).where(
                ExecutionSession.ref == self.ref))).one()
            row.seq = 4100
            await session.execute(insert(ExecutionEvent), [
                {"session_id": row.id, "seq": seq, "kind": "text", "text": str(seq)}
                for seq in range(1, 4101)])
            await session.commit()
        for _ in range(2):
            async with db.SessionLocal() as session:
                page = await execution_sessions.read_task(session, self.tid, self.ref, since=4096)
                self.assertEqual(page["persistedThrough"], 4100)
                self.assertEqual([e["seq"] for e in page["items"]], [4097, 4098, 4099, 4100])

    async def test_out_of_order_packet_conflict_and_wrong_boot_are_rejected(self):
        await self.seed()
        for message, code in [(self.message(2), "DELIVERY_GAP"),
                              ({**self.message(), "bootId": "old-boot"}, "DELIVERY_IDENTITY_MISMATCH")]:
            with self.assertRaisesRegex(runner_event_delivery.DeliveryRejected, code):
                await self.accept(message)
        await self.accept(self.message())
        changed = self.message()
        changed["snapshot"]["items"][0]["text"] = "altered"
        changed["digest"] = snapshot_digest(changed["snapshot"])
        with self.assertRaisesRegex(runner_event_delivery.DeliveryRejected, "DELIVERY_CONTENT_CONFLICT"):
            await self.accept(changed)
        with self.assertRaisesRegex(runner_event_delivery.DeliveryRejected, "DELIVERY_STREAM_MISMATCH"):
            await self.accept({**self.message(2), "streamId": "b" * 32})
        await self.accept(self.message(2, (2,)))
        for older in (self.message(), changed):
            with self.assertRaisesRegex(runner_event_delivery.DeliveryRejected, "DELIVERY_STALE"):
                await self.accept(older)
        row, events = await self.stored()
        self.assertEqual((row.delivery_seq, len(events)), (2, 2))

    async def test_old_round_repairs_history_without_regressing_current_state(self):
        await self.seed()
        await self.accept(self.message(1, (1, 2), round_no=2))
        await self.accept(self.message(2, (3,), round_no=1, state="failed"))
        row, events = await self.stored()
        self.assertEqual((row.metadata_["round"], row.state, row.delivery_seq), (2, "running", 2))
        self.assertEqual(len(events), 3)
        self.assertNotIn("terminalSettlement", row.metadata_)

    async def test_same_owner_cannot_rebind_ref_to_another_runner(self):
        await self.seed()
        self.runner.id = self.prefix + "-other-runner"
        with self.assertRaisesRegex(runner_event_delivery.DeliveryRejected, "DELIVERY_SESSION_MISMATCH"):
            await self.accept(self.message())
        row, events = await self.stored()
        self.assertEqual(events, [])
        self.assertNotEqual(row.runner_id, self.runner.id)

    async def test_personal_cloud_facts_require_frozen_owner_runner_and_ref_grant(self):
        from app.automation_models import RunnerNode
        from app.conversation_handoff_models import ConversationHandoff
        await self.seed()
        self.runner.owner_user_id = self.user_id
        async with db.SessionLocal() as session:
            task = await session.get(models.Task, self.tid)
            task.owner_user_id = self.user_id
            session.add_all([
                RunnerNode(id=self.runner.id, owner_user_id=self.user_id, auth_state="active"),
                ConversationHandoff(id=self.prefix + "-handoff", owner_client_id=self.client_id,
                    owner_user_id=self.user_id, transfer_id=self.prefix, task_id=self.tid,
                    phase="committed", sha256="", request_hash="fixture",
                    options={"targetSnapshot": {"runnerId": self.runner.id}},
                    receipt={"ref": self.ref, "runnerId": self.runner.id})])
            await session.commit()
        await self.accept(self.message())
        wrong_ref = self.message(2, (2,))
        wrong_ref["ref"] = wrong_ref["snapshot"]["ref"] = "unauthorized-ref"
        wrong_ref["digest"] = snapshot_digest(wrong_ref["snapshot"])
        with self.assertRaisesRegex(runner_event_delivery.DeliveryRejected, "DELIVERY_FORBIDDEN"):
            await self.accept(wrong_ref)
        async with db.SessionLocal() as session:
            node = await session.get(RunnerNode, self.runner.id)
            node.owner_user_id = self.prefix + "-colleague"
            await session.commit()
        with self.assertRaisesRegex(runner_event_delivery.DeliveryRejected, "DELIVERY_FORBIDDEN"):
            await self.accept(self.message(2, (2,)))

    async def test_concurrent_delivery_retains_single_receipt_and_event(self):
        await self.seed()
        results = await asyncio.gather(self.accept(self.message()), self.accept(self.message()),
                                       return_exceptions=True)
        self.assertTrue(any(isinstance(result, tuple) for result in results), results)
        await self.accept(self.message())
        row, events = await self.stored()
        self.assertEqual((row.delivery_seq, len(events)), (1, 1))


class RunnerTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_network_job_replies_clean_admission_receipts_and_ignore_private_pipe_marker(self):
        from app.services import ai_local
        machine = runner_main.Runner.__new__(runner_main.Runner)
        raw = {"ok": True, "data": {"acceptedSelection": {"agentId": "qwen", "modelName": "private-wire"},
               "error": "private-wire private-key http://private.invalid",
               "quotaUsageToken": "private-ticket"}}
        machine._job = AsyncMock(return_value=raw)
        machine._send = AsyncMock()
        with patch.dict(ai_local._RUNS, {"private-ref": {"modelLocalOnly": True}}):
            for operation in ("job.has", "job.comment", "job.session", "job.status", "job.info"):
                with self.subTest(operation=operation):
                    await machine._on({"op": operation, "id": "rpc", "ref": "private-ref", "_localParent": True})
                    self.assertNotIn("_localParent", machine._job.await_args.args[0])
                    public = machine._send.await_args.args[0]
                    self.assertEqual(public["data"]["acceptedSelection"]["modelName"], "")
                    self.assertNotIn("private-key", str(public))
                    self.assertNotIn("private-ticket", str(public))
                    self.assertNotIn("private.invalid", str(public))

    async def test_remote_job_requests_cannot_inject_local_model_configuration(self):
        machine = runner_main.Runner.__new__(runner_main.Runner)
        for operation in ("job.dispatch", "job.comment"):
            with self.subTest(operation=operation):
                result = await machine._job({"op": operation,
                    "cfg": {"llm": {"localOnly": True, "model": "private-wire"}}})
                self.assertFalse(result["ok"])
                self.assertEqual(result["code"], "LOCAL_MODEL_REMOTE_FORBIDDEN")

    async def test_remote_session_status_and_info_preserve_device_model_privacy(self):
        from app.services import ai_local, local_stream
        machine = runner_main.Runner.__new__(runner_main.Runner)
        machine._admission = SimpleNamespace(latest_for_ref=lambda *args, **kwargs: None)
        owned = {"modelLocalOnly": True, "usageReceipts": [
            {"localOnly": True, "reportable": False, "usage": {"input": 99}}]}
        raw = {"model": "private-wire", "usage": {"input": 99}, "tokens": {"input": 99},
               "activeExecutionSelection": {"agentId": "qwen", "modelName": "private-wire"}}
        with patch.dict(ai_local._RUNS, {"fixture-private": owned}), \
                patch.object(ai_local, "session_sync", return_value=raw), \
                patch.object(ai_local, "status_sync", return_value=raw), \
                patch.object(ai_local, "runner_info_sync", return_value=raw), \
                patch.object(local_stream, "authorization_required_sync", return_value=False):
            for operation in ("job.session", "job.status", "job.info"):
                with self.subTest(operation=operation):
                    remote = await machine._job({"op": operation, "ref": "fixture-private"})
                    self.assertEqual(remote["data"]["model"], "")
                    self.assertEqual(remote["data"]["usage"], {})
                    self.assertNotIn("usageReceipts", remote["data"])
                    local = await machine._job({"op": operation, "ref": "fixture-private", "_localParent": True})
                    self.assertEqual(local["data"]["model"], "private-wire")

    async def test_hub_snapshots_omit_local_model_metadata_and_local_usage(self):
        from app.services import ai_local, local_base
        machine = runner_main.Runner.__new__(runner_main.Runner)
        machine._agent_inventory, machine._session_marks = [], {}
        run = {"ref": "private-ref", "taskId": "task", "model": "private-wire-model",
               "state": "done", "seq": 1, "tokens": {"input": 100},
               "ctxPct": 50, "ctxWindow": 20000, "ctxWindowKnown": True,
               "usage": {"input_tokens": 110}}
        owned = {"cfg": {"llm": {"localOnly": True}}, "usageReceipts": [
            {"localOnly": True, "reportable": False, "usage": {"input_tokens": 100}},
            {"localOnly": False, "reportable": True, "model": "hub-model",
             "quotaUsageToken": "private-ticket", "usage": {"input_tokens": 10}},
        ]}
        with patch.object(ai_local, "console_list_sync", return_value={"runs": [run]}), \
                patch.object(ai_local, "session_sync", return_value={"seq": 1, "items": [
                    {"seq": 1, "kind": "usage", "localModelMetadata": True,
                     "usage": {"input_tokens": 100}, "text": ""}]}), \
                patch.dict(local_base._RUNS, {"private-ref": owned}):
            snapshots, _ = machine._session_snapshots()
        snapshot = snapshots[0]
        self.assertEqual(snapshot["model"], "")
        self.assertEqual(snapshot["tokens"], {})
        self.assertEqual(snapshot["ctxWindow"], 0)
        self.assertFalse(snapshot["ctxWindowKnown"])
        self.assertEqual(snapshot["usage"]["input_tokens"], 10)
        self.assertNotIn("private-ticket", str(snapshot))
        self.assertNotIn("private-wire-model", str(snapshot))
        self.assertEqual(snapshot["items"][0]["seq"], 1)
        self.assertNotIn("usage", snapshot["items"][0])

    async def test_unknown_legacy_runner_model_and_error_are_not_republished_to_hub(self):
        from app.services import ai_local, local_base
        machine = runner_main.Runner.__new__(runner_main.Runner)
        machine._agent_inventory, machine._session_marks = [], {}
        legacy = {"ref": "legacy-private", "taskId": "task", "cli": "qwen", "seq": 1,
                  "model": "old-private-wire", "error": "old-private-wire old-private-key",
                  "usage": {"input": 99}, "tokens": {"input": 99}}
        with patch.object(ai_local, "console_list_sync", return_value={"runs": [legacy]}), \
                patch.object(ai_local, "session_sync", return_value={**legacy, "items": []}), \
                patch.dict(local_base._RUNS, {"legacy-private": legacy}):
            snapshots, _ = machine._session_snapshots()
        self.assertEqual(snapshots[0]["model"], "")
        self.assertEqual(snapshots[0]["usage"], {})
        self.assertEqual(snapshots[0]["tokens"], {})
        self.assertNotIn("old-private-wire", str(snapshots))
        self.assertNotIn("old-private-key", str(snapshots))

    async def test_native_only_histories_cannot_starve_task_event_collection(self):
        from app.services import ai_local
        machine = runner_main.Runner.__new__(runner_main.Runner)
        machine._agent_inventory, machine._session_marks = [], {}
        runs = [{"ref": "native-%02d" % number, "state": "running", "started": 2, "seq": 1}
                for number in range(13)]
        runs.append({"ref": "cloud-ref", "taskId": "cloud-task", "state": "running", "seq": 1})
        with patch.object(ai_local, "console_list_sync", return_value={"runs": runs}), \
                patch.object(ai_local, "session_sync", return_value={"seq": 1,
                    "items": [{"seq": 1, "kind": "text", "text": "fixture"}]}) as read:
            snapshots, marks = machine._session_snapshots()
        self.assertEqual([item["ref"] for item in snapshots], ["cloud-ref"])
        self.assertEqual(marks[0][:2], ("cloud-ref", 1))
        read.assert_called_once_with({}, "cloud-ref", 0, 300)

    async def test_key_specific_probe_never_confuses_an_old_native_turn_with_new_admission(self):
        from app.services import ai_local, local_base
        with tempfile.TemporaryDirectory() as root, patch.object(local_base, "_data_root", return_value=root):
            machine = runner_main.Runner("https://fixture.invalid", "", "fixture-device", "fixture-runner")
            try:
                with patch.dict(ai_local._RUNS, {"fixture-ref": {"state": "done"}}, clear=True):
                    missing = await machine._job({"op": "job.has", "ref": "fixture-ref",
                                                  "admissionKey": "comment:new-turn"})
                    self.assertFalse(missing["data"]["has"])
                    self.assertTrue(missing["data"]["admissionDurable"])
                    self.assertEqual(missing["data"]["admissionKey"], "comment:new-turn")
                    machine._admission.submit("comment:new-turn", "fixture-ref", "manual", "comment", {})
                    found = await machine._job({"op": "job.has", "ref": "fixture-ref",
                                                "admissionKey": "comment:new-turn"})
                    self.assertTrue(found["data"]["has"])
                    mismatch = await machine._job({"op": "job.has", "ref": "another-ref",
                                                   "admissionKey": "comment:new-turn"})
                    self.assertFalse(mismatch["ok"])
                    self.assertEqual(mismatch["code"], "ADMISSION_REF_MISMATCH")
            finally:
                machine._admission._journal.close()

    async def test_collection_commits_before_marks_and_failed_disk_write_keeps_archive_cursor(self):
        with tempfile.TemporaryDirectory() as root:
            machine = runner_main.Runner.__new__(runner_main.Runner)
            machine._snap_lock, machine._session_marks = asyncio.Lock(), {}
            machine._event_outbox = Outbox(root, "fixture", max_packets=1)
            machine._session_snapshots = lambda: ([snapshot()], [("fixture-ref", 1, "running")])
            await machine._capture_sessions()
            self.assertEqual(machine._session_marks, {"fixture-ref": (1, "running")})
            self.assertTrue(machine._outbox_blocked)
            machine._session_snapshots = lambda: ([snapshot(seqs=(2,))], [("fixture-ref", 2, "done")])
            with self.assertRaises(OutboxFull):
                await machine._capture_sessions()
            self.assertEqual(machine._session_marks, {"fixture-ref": (1, "running")})

    async def test_legacy_hub_displays_retained_packet_without_deleting_it(self):
        with tempfile.TemporaryDirectory() as root:
            machine = runner_main.Runner.__new__(runner_main.Runner)
            machine._session_ack, machine._delivery_attempts = False, {}
            machine._event_outbox = Outbox(root, "fixture")
            machine._event_outbox.append(snapshot(), ("fixture-ref", 1, "done"))
            machine._send_strict = AsyncMock()
            await machine._deliver_sessions()
            self.assertEqual(machine._send_strict.call_args.args[0]["op"], "session.event")
            self.assertEqual(len(machine._event_outbox.pending()), 1)

    async def test_legacy_replays_every_packet_and_upgrade_requires_each_durable_ack(self):
        with tempfile.TemporaryDirectory() as root:
            machine = runner_main.Runner.__new__(runner_main.Runner)
            machine.id, machine.client_id, machine.boot_id = "runner", "device", "boot"
            machine.ws = SimpleNamespace()
            machine._agent_inventory, machine._skill_inventory, machine._skill_catalog = [], [], []
            machine._agent_inventory_at = 0
            machine.work_root, machine.tags = "", []
            machine._admission_report = lambda **_: {}
            machine._send_raw, machine._send_strict = AsyncMock(), AsyncMock()
            machine._snap_lock, machine._admission_wake = asyncio.Lock(), asyncio.Event()
            machine._event_outbox = Outbox(root, "fixture")
            for seq in range(1, 15):
                machine._event_outbox.append(snapshot(seqs=(seq,)), ("fixture-ref", seq, "running"))
            machine._session_marks = machine._event_outbox.marks()

            async def hello(caps):
                with patch.object(runner_main, "_negotiate_hello", AsyncMock(return_value=(
                        {"op": "welcome", "caps": caps}, []))), \
                        patch.object(runner_main.runner_connection_status, "report"):
                    await machine._hello()

            await hello([])
            await machine._deliver_sessions()
            await machine._deliver_sessions()
            seen = [call.args[0]["sessions"][0]["items"][0]["seq"]
                    for call in machine._send_strict.call_args_list]
            self.assertEqual(seen, list(range(1, 15)), "legacy replay must cross its bounded window")
            self.assertEqual(len(machine._event_outbox.replay_pending(100)), 14)
            self.assertEqual(machine._session_marks["fixture-ref"][0], 14)

            machine._send_strict.reset_mock()
            await hello([])
            await machine._deliver_sessions()
            self.assertEqual(machine._send_strict.call_args_list[0].args[0]["sessions"][0]["seq"], 1)
            self.assertEqual(len(machine._event_outbox.replay_pending(100)), 14)

            await hello(["sessionAck1"])
            for seq in range(1, 15):
                machine._send_strict.reset_mock()
                await machine._deliver_sessions()
                message = machine._send_strict.call_args.args[0]
                self.assertEqual((message["op"], message["deliverySeq"]), ("session.deliver", seq))
                self.assertEqual(len(machine._event_outbox.replay_pending(100)), 15 - seq)
                await machine._queue_message({**message, "op": "session.ack"}, machine.ws)
            self.assertEqual(machine._event_outbox.pending(), [])
            self.assertEqual(machine._event_outbox.marks()["fixture-ref"][0], 14)

    async def test_send_success_is_not_ack_and_stale_connection_cannot_delete_packet(self):
        with tempfile.TemporaryDirectory() as root:
            machine = runner_main.Runner.__new__(runner_main.Runner)
            machine.id, machine.boot_id = "fixture-runner", "fixture-boot"
            machine.ws = SimpleNamespace(send=AsyncMock())
            machine._send_lock, machine._snap_lock = asyncio.Lock(), asyncio.Lock()
            machine._send_target = contextvars.ContextVar("fixture-target", default=None)
            machine._session_ack, machine._delivery_attempts = True, {}
            machine._event_outbox = Outbox(root, "fixture")
            machine._admission_wake = asyncio.Event()
            machine._event_outbox.append(snapshot(), ("fixture-ref", 1, "done"))
            packet = machine._event_outbox.pending()[0]
            await machine._deliver_sessions()
            await machine._deliver_sessions()
            self.assertEqual(machine.ws.send.call_count, 1, "pending retries must back off")
            self.assertEqual(len(machine._event_outbox.pending()), 1)
            ack = {**packet, "op": "session.ack", "version": 1,
                   "runnerId": machine.id, "bootId": machine.boot_id}
            await machine._queue_message(ack, object())
            self.assertEqual(len(machine._event_outbox.pending()), 1)
            await machine._queue_message(ack, machine.ws)
            self.assertEqual(machine._event_outbox.pending(), [])

    async def test_queue_pressure_does_not_ack_or_block_control_reply(self):
        queue = asyncio.Queue(maxsize=1)
        self.assertTrue(runner_ws._enqueue_telemetry(queue, {"deliverySeq": 1}))
        self.assertFalse(runner_ws._enqueue_telemetry(queue, {"deliverySeq": 2}))
        self.assertEqual(queue.qsize(), 1)


if __name__ == "__main__":
    unittest.main()
