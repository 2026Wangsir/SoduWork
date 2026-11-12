"""Verify explicit local selection over real HTTP with device authentication and isolated SQLite,
without Runner or model connections.
"""
import copy
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

from sqlalchemy import select
import test_collaboration_receipt_delivery as receipts
from app.automation_models import ExecutionSession, ResourceLease, WorkflowRun
from app.models import Task, TaskEvent
from app.realtime import hub


class NativeExecutionChoiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.base = receipts.ReceiptDeliveryTests("test_null_legacy_conversation_receipt_keeps_requirement_detail_readable")
        await self.base.asyncSetUp()
        self.http, self.sessions = self.base.http, self.base.sessions
        self.routing = {"selectedStrategy": "workflow", "workflowBindingId": "old-flow",
            "selectedWorkflowBindingId": "old-flow", "outputContract": {"kind": "documents"},
            "executionContext": {"strategy": "workflow", "runner": {"mode": "remote"}, "model": "old-model"}}
        async with self.sessions() as session, session.begin():
            task = await session.get(Task, "task")
            task.status = "todo"
            task.work_routing = copy.deepcopy(self.routing)
        self.publish = patch.object(hub, "publish", new_callable=AsyncMock)
        self.publish.start()

    async def asyncTearDown(self):
        self.publish.stop()
        await self.base.asyncTearDown()

    async def prepare(self, tid="task", device="owner", **body):
        return await self.http.post(f"/api/v1/tasks/{tid}/conversation-turn", headers=self.base.headers[device],
            json={"action": "prepare", "conversationId": "native-chat", "turnId": "native-turn",
                  "executor": "native", "executionChoice": "native", "agentId": "local:pi", **body})

    async def test_authenticated_owner_saves_choice_and_receipt_once_without_losing_contract(self):
        for device in ("creator", "owner-other-device", "unrelated"):
            self.assertEqual((await self.prepare(device=device)).status_code, 404)
        response = await self.prepare()
        self.assertEqual(response.status_code, 200, response.text)
        routing = response.json()["task"]["workRouting"]
        self.assertEqual(routing["selectedStrategy"], "direct")
        self.assertEqual(routing["executionContext"]["runner"], {"mode": "local"})
        self.assertEqual(routing["executionContext"]["agent"]["id"], "local:pi")
        self.assertEqual(routing["outputContract"], self.routing["outputContract"])
        self.assertFalse(routing["workflowBindingId"])
        self.assertEqual((await self.prepare()).status_code, 200)
        self.assertEqual((await self.prepare(turnId="another-turn")).status_code, 409)
        async with self.sessions() as session:
            events = (await session.scalars(select(TaskEvent).where(TaskEvent.task_id == "task"))).all()
            self.assertEqual([x.kind for x in events].count("execution.choice"), 1)
            self.assertEqual([x.kind for x in events].count("conversation.turn"), 1)
            choice = next(x.detail for x in events if x.kind == "execution.choice")
            self.assertEqual(choice["previousBindingId"], "old-flow")

    async def test_live_lease_workflow_and_dispatch_prevent_native_takeover(self):
        for blocker in ("lease", "workflow", "dispatch", "old-dispatch", "session-without-event"):
            with self.subTest(blocker=blocker):
                async with self.sessions() as session, session.begin():
                    session.add(Task(id=blocker, title="隔离待办", status="todo", owner_client_id="owner",
                        work_routing=copy.deepcopy(self.routing)))
                    if blocker == "lease":
                        session.add(ResourceLease(resource_kind="workflow-start", resource_key=blocker,
                            token="fixture-lease", lease_until=datetime.now(timezone.utc) + timedelta(minutes=1)))
                    elif blocker == "workflow":
                        session.add(WorkflowRun(task_id=blocker, plugin_id="fixture", plugin_version_id="fixture",
                            state="running"))
                    else:
                        session.add(ExecutionSession(task_id=blocker, ref=blocker, state="running"))
                        if blocker != "session-without-event":
                            session.add(TaskEvent(task_id=blocker, kind="ai.dispatched", detail={"ref": blocker},
                                at=datetime.now(timezone.utc) - timedelta(minutes=20 if blocker == "old-dispatch" else 0)))
                response = await self.prepare(blocker)
                self.assertEqual(response.status_code, 409, response.text)
                async with self.sessions() as session:
                    self.assertEqual((await session.get(Task, blocker)).work_routing, self.routing)

    async def test_invalid_agent_executor_and_archived_task_do_not_change_saved_route(self):
        for body in ({"agentId": "runner:r:pi"}, {"agentId": ""}, {"executor": "workflow"}):
            with self.subTest(body=body):
                self.assertIn((await self.prepare(**body)).status_code, (409, 422))
        async with self.sessions() as session, session.begin():
            task = await session.get(Task, "task")
            self.assertEqual(task.work_routing, self.routing)
            task.archived_at = datetime.now(timezone.utc)
        self.assertEqual((await self.prepare()).status_code, 409)

    async def test_dispatch_instructions_are_complete_immutable_and_execution_scoped(self):
        instructions = {"note": "First line\n" + "文" * 1800, "submissionMode": "manual"}
        response = await self.prepare(submissionMode="manual", dispatchInstructions=instructions)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((await self.prepare(submissionMode="manual", dispatchInstructions=instructions)).status_code, 200)
        changed = await self.prepare(submissionMode="manual", dispatchInstructions={**instructions, "note": "Changed"})
        self.assertEqual(changed.status_code, 409, changed.text)
        for device in ("owner", "creator", "requester", "unrelated"):
            page = await self.http.get("/api/v1/tasks/task/events", headers=self.base.headers[device])
            self.assertEqual(page.status_code, 404 if device == "unrelated" else 200, page.text)
            if device == "unrelated":
                continue
            records = [row for row in page.json()["events"] if row["kind"] == "execution.instructions"]
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["detail"], {**instructions, "schemaVersion": 1,
                "effectiveSubmissionMode": "manual", "conversationId": "native-chat",
                "turnId": "native-turn", "executor": "native"})
        failed = await self.http.post("/api/v1/tasks/task/conversation-turn", headers=self.base.headers["owner"],
            json={"action": "fail", "conversationId": "native-chat", "turnId": "native-turn", "executor": "native"})
        self.assertEqual(failed.status_code, 200, failed.text)
        later = await self.prepare(turnId="next", submissionMode="auto", dispatchInstructions={"note": "Second", "submissionMode": "auto"})
        self.assertEqual(later.status_code, 200, later.text)
        async with self.sessions() as session:
            records = (await session.scalars(select(TaskEvent).where(TaskEvent.kind == "execution.instructions").order_by(TaskEvent.at))).all()
            self.assertEqual([row.detail["note"] for row in records], [instructions["note"], "Second"])

    async def test_invalid_or_legacy_dispatch_metadata_does_not_invent_history(self):
        for instructions in ({}, [], {"note": 42, "submissionMode": "default"},
                             {"note": "x" * 2001, "submissionMode": "default"},
                             {"note": "x", "submissionMode": "invalid"},
                             {"note": "x", "submissionMode": "manual"}):
            response = await self.prepare(dispatchInstructions=instructions)
            self.assertEqual(response.status_code, 422, response.text)
        legacy = await self.prepare()
        self.assertEqual(legacy.status_code, 200, legacy.text)
        retry = await self.prepare(dispatchInstructions={"note": "Do not backfill", "submissionMode": "default"})
        self.assertEqual(retry.status_code, 200, retry.text)
        async with self.sessions() as session:
            records = (await session.scalars(select(TaskEvent).where(TaskEvent.kind == "execution.instructions"))).all()
            self.assertEqual(records, [])

    async def test_all_queue_executors_keep_only_explicit_user_fields(self):
        for executor in ("native", "dispatch", "workflow"):
            async with self.sessions() as session, session.begin():
                session.add(Task(id=executor, title="Queue case", status="todo", owner_client_id="owner",
                    owner_user_id="executor", work_routing={"outputContract": {"kind": "documents"}}))
            response = await self.prepare(executor, executor=executor, executionChoice="",
                dispatchInstructions={"note": "Explicit note", "submissionMode": "default",
                                      "model": "Do not copy", "prompt": "Not a user note"})
            self.assertEqual(response.status_code, 200, response.text)
            async with self.sessions() as session:
                records = (await session.scalars(select(TaskEvent).where(
                    TaskEvent.task_id == executor, TaskEvent.kind == "execution.instructions"))).all()
                self.assertEqual(len(records), 1)
                self.assertEqual(records[0].detail["effectiveSubmissionMode"], "auto")
                self.assertEqual(records[0].detail["executor"], executor)
                self.assertNotIn("model", records[0].detail)
                self.assertNotIn("prompt", records[0].detail)

    async def test_recording_default_choice_does_not_change_the_existing_submission_policy(self):
        async with self.sessions() as session, session.begin():
            task = await session.get(Task, "task")
            task.work_routing = {**task.work_routing, "executionSubmissionMode": "manual"}
        response = await self.prepare(dispatchInstructions={"note": "", "submissionMode": "default"})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["task"]["workRouting"]["executionSubmissionMode"], "manual")
        async with self.sessions() as session:
            record = (await session.scalars(select(TaskEvent).where(TaskEvent.kind == "execution.instructions"))).one()
            self.assertEqual(record.detail["submissionMode"], "default")
            self.assertEqual(record.detail["effectiveSubmissionMode"], "manual")
            self.assertEqual(record.detail["note"], "")


if __name__ == "__main__":
    unittest.main()
