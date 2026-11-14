"""Real HTTP/SQLite delivery and creator-owned review without private model metadata."""
import json
import tempfile
import unittest
from unittest.mock import patch

from sqlalchemy import select

import test_unified_requirements as fixture
from app import automation_models as am, models
from app.services import storage


class LocalRequirementDeliveryTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixture.UnifiedRequirementTests.asyncTearDown
    call = fixture.UnifiedRequirementTests.call

    async def asyncSetUp(self):
        await fixture.UnifiedRequirementTests.asyncSetUp(self)
        directory = self.enterContext(tempfile.TemporaryDirectory(prefix="soduwork-local-review-"))
        self.enterContext(patch.object(storage, "_LOCAL_DIR", directory))

    async def create_running(self, mode):
        response = await self.call("POST", "tasks", json={
            "title": "Single-account delivery", "note": "Create a reviewable report",
            "acceptanceCriteria": ["Includes the completed report"], "triageStage": "ready"})
        self.assertEqual(response.status_code, 200, response.text)
        tid = response.json()["id"]
        async with self.sessions() as session:
            task = await session.get(models.Task, tid)
            self.assertEqual(task.created_by, "owner")
            self.assertEqual(task.assignee_user_id, "owner")
            task.status = "doing"
            task.work_routing = {"executionSubmissionMode": mode, "conversationTurn": {
                "turnId": "turn", "conversationId": "chat", "executor": "native", "state": "running"}}
            await session.commit()
        return tid

    async def deliver(self, tid, model=""):
        result = await self.call("POST", "tasks/" + tid + "/conversation-delivery",
            data={"conversationId": "chat", "turnId": "turn", "paths": "report.md",
                  "categories": "primary", "outcome": "completed", "model": model},
            files={"files": ("report.md", b"Complete report with verification evidence", "text/markdown")})
        if result.status_code == 200:
            settled = await self.call("POST", "tasks/" + tid + "/conversation-turn", json={
                "conversationId": "chat", "turnId": "turn", "executor": "native", "action": "complete"})
            self.assertEqual(settled.status_code, 200, settled.text)
        return result

    async def assert_pending_creator_review(self, tid):
        detail = await self.call("GET", "tasks/" + tid)
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertEqual(detail.json()["requirementStage"], "reviewing")
        self.assertTrue(detail.json()["canReview"])
        async with self.sessions() as session:
            request = await session.scalar(select(am.ApprovalRequest).where(am.ApprovalRequest.task_id == tid))
            self.assertEqual((request.action, request.status, request.required_count), ("review", "pending", 1))
            assignments = (await session.scalars(select(am.ApprovalAssignment).where(
                am.ApprovalAssignment.request_id == request.id))).all()
            self.assertEqual([row.user_id for row in assignments], ["owner"])
            self.assertIsNone((await session.get(models.Task, tid)).reviewed_at)
            self.assertIsNone(await session.scalar(select(am.ApprovalDecision.id).where(
                am.ApprovalDecision.request_id == request.id)))
        foreign = await self.call("POST", "tasks/" + tid + "/review", "peer", json={})
        self.assertIn(foreign.status_code, (403, 404), foreign.text)

    async def test_single_account_auto_delivery_is_identical_for_private_and_managed_models(self):
        for model in ("", "managed-model"):
            with self.subTest(model=model):
                tid = await self.create_running("auto")
                response = await self.deliver(tid, model)
                self.assertEqual(response.status_code, 200, response.text)
                self.assertTrue(response.json()["ok"])
                await self.assert_pending_creator_review(tid)

    async def test_single_account_manual_submission_keeps_creator_eligible(self):
        tid = await self.create_running("manual")
        delivered = await self.deliver(tid)
        self.assertEqual(delivered.status_code, 200, delivered.text)
        self.assertTrue(delivered.json()["pendingSubmission"])
        async with self.sessions() as session:
            self.assertIsNone(await session.scalar(select(am.ApprovalRequest.id).where(
                am.ApprovalRequest.task_id == tid)))
        response = await self.call("POST", "tasks/" + tid + "/submit-review", json={"note": "Ready for review"})
        self.assertEqual(response.status_code, 200, response.text)
        await self.assert_pending_creator_review(tid)

    async def test_legacy_device_references_are_not_persisted_with_deliverables(self):
        for model in ("local:model-" + "a" * 32, "local:private:wire-model",
                      "image::device:private::local:model-" + "b" * 32):
            with self.subTest(model=model):
                tid = await self.create_running("auto")
                response = await self.deliver(tid, model)
                self.assertEqual(response.status_code, 200, response.text)
                await self.assert_pending_creator_review(tid)
                async with self.sessions() as session:
                    events = (await session.scalars(select(models.TaskEvent).where(models.TaskEvent.task_id == tid))).all()
                    attachments = (await session.scalars(select(models.Attachment).where(models.Attachment.task_id == tid))).all()
                    captured = json.dumps([[(row.actor, row.detail) for row in events],
                                           [(row.uploaded_by, row.evidence_meta) for row in attachments]])
                    self.assertNotIn(model, captured)
                    self.assertNotIn("local:", captured)

    async def test_missing_creator_is_not_inferred_from_the_current_executor(self):
        tid = await self.create_running("manual")
        async with self.sessions() as session:
            task = await session.get(models.Task, tid)
            task.created_by = None
            await session.commit()
        delivered = await self.deliver(tid)
        self.assertEqual(delivered.status_code, 200, delivered.text)
        denied = await self.call("POST", "tasks/" + tid + "/submit-review", json={})
        self.assertEqual(denied.status_code, 409, denied.text)
        self.assertIn("当前只能分配给 0 人", denied.json()["detail"])
        async with self.sessions() as session:
            self.assertIsNone((await session.get(models.Task, tid)).created_by)
            self.assertIsNone(await session.scalar(select(am.ApprovalAssignment.id)))


if __name__ == "__main__":
    unittest.main()
