"""HTTP, authorization and concurrent-reader tests for immutable acceptance exports."""
import os
import shutil
import sqlite3
import tempfile
import unittest
from contextlib import closing
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import FastAPI, HTTPException, Request
from sqlalchemy import event, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am, models
from app.api import tasks
from app.deps import current_client
from app.services import acceptance_summary as summary
from test_unified_requirements import _schema_template


class AcceptanceSummaryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        directory = tempfile.TemporaryDirectory(prefix="soduwork-summary-test-")
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "test.db"
        shutil.copy2(_schema_template(), path)
        with closing(sqlite3.connect(path)) as connection:
            connection.execute("PRAGMA journal_mode=WAL")
        self.engine = create_async_engine("sqlite+aiosqlite:///" + path.as_posix())
        self.addAsyncCleanup(self.engine.dispose)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.at = datetime(2026, 1, 2, 3, 4, 5, tzinfo=timezone.utc)
        self.clients = {}
        async with self.sessions() as session:
            session.add_all([models.OrgUnit(id="company", name="Company"),
                             models.OrgUnit(id="outside", name="Outside")])
            for uid, org in (("owner", "company"), ("colleague", "company"), ("stranger", "outside")):
                session.add(models.User(id=uid, username=uid, org_id=org, is_active=True))
                client = models.Client(id=uid, user_ref=uid, auth_state="active")
                self.clients[uid] = client
                session.add(client)
            session.add(models.Task(id="task", title="PRIVATE_EXECUTION_TITLE", note="PRIVATE_EXECUTION_NOTE",
                requirement_content={"title": "Delivery example", "note": "Current public background"},
                owner_client_id="owner", created_by="owner", shared_org_id="company", status="done",
                requirement_version=3, acceptance_criteria=["Current requirement criterion"],
                work_routing={"credential": "PRIVATE_RUNTIME_CREDENTIAL"}))
            session.add(am.ArtifactVersion(id="artifact", task_id="task", seq=2, kind="files",
                checksum="fixed-digest", state="candidate", source_ref="execution-ref", created_at=self.at,
                manifest={"schemaVersion": "soduwork.delivery/1", "problems": [],
                    "primary": [{"id": "output", "name": "result.md", "validation": {
                    "state": "passed", "reason": "Recorded structural check"}}],
                    "supporting": [], "credential": "PRIVATE_MANIFEST_CREDENTIAL"}))
            session.add(am.ArtifactVersion(id="old-artifact", task_id="task", seq=1, kind="files",
                checksum="old-digest", manifest={"primary": [{"id": "old-output", "name": "OLD_OUTPUT"}]}))
            session.add(am.ApprovalRequest(id="approval", task_id="task", artifact_version_id="artifact",
                action="review", status="pending", created_at=self.at,
                context={"gate": {"criteria": [{"id": "c1", "label": "Frozen review criterion"}]},
                         "runtime": "PRIVATE_APPROVAL_RUNTIME"}))
            session.add(am.ApprovalRequest(id="old-approval", task_id="task", artifact_version_id="old-artifact",
                action="review", status="approved", resolved_at=self.at - timedelta(days=1)))
            session.add(am.ApprovalDecision(id="old-decision", request_id="old-approval", user_id="owner",
                user_name="Owner", decision="approve", note="OLD_APPROVAL_NOTE"))
            session.add(models.Attachment(id="output", task_id="task", filename="CURRENT_MUTABLE_NAME",
                role="output", uploaded_by="owner", storage_key="PRIVATE_STORAGE_PATH"))
            session.add(models.TaskEvent(task_id="task", kind="ai.output", detail={"text": "PRIVATE_CHAT_CONTENT"}))
            await session.commit()
        app = FastAPI()
        app.include_router(tasks.router)

        async def identity(request: Request):
            client = self.clients.get(request.headers.get("X-Test-Identity", ""))
            if client is None:
                raise HTTPException(401, "Authentication required")
            return client

        app.dependency_overrides[current_client] = identity
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test")
        self.addAsyncCleanup(self.http.aclose)
        engine_patch = patch.object(summary.db, "engine", self.engine)
        engine_patch.start()
        self.addCleanup(engine_patch.stop)

    async def export(self, identity="owner", **query):
        return await self.http.get("/api/v1/tasks/task/acceptance-summary",
                                   headers={"X-Test-Identity": identity}, params=query)

    async def test_pending_snapshot_never_inherits_previous_approval(self):
        response = await self.export(requirementVersion=3, artifactVersionId="artifact")
        self.assertEqual(response.status_code, 200, response.text)
        value = response.json()
        self.assertEqual(value["artifactVersionId"], "artifact")
        self.assertEqual(value["requirementVersion"], 3)
        self.assertEqual(value["filename"], "Delivery example-acceptance.md")
        markdown = value["markdown"]
        for expected in ("待验收", "尚无验收决定", "Frozen review criterion", "Current requirement criterion",
                         "当前需求版本：3", "未保存完整的历史需求正文", "result\\.md", "Recorded structural check"):
            self.assertIn(expected, markdown)
        for excluded in ("OLD", "PRIVATE", "CURRENT", "ticket=", "已通过"):
            self.assertNotIn(excluded, markdown)

    async def test_approved_snapshot_uses_matching_decision_and_recorded_checks(self):
        async with self.sessions() as session:
            request = await session.get(am.ApprovalRequest, "approval")
            request.status = "approved"
            request.resolved_at = self.at
            request.context = {**request.context, "aiAcceptanceReports": {
                "owner": {"artifactVersionId": "artifact", "requirementVersion": 2,
                          "execution": {"agent": "Recorded reviewer", "conversationId": "PRIVATE_CONVERSATION"},
                          "report": {"checks": [
                    {"label": "Recorded check", "result": "pass", "evidence": "Recorded evidence"}]}},
                "old": {"artifactVersionId": "old-artifact", "report": {"checks": [
                    {"label": "WRONG_VERSION_CHECK", "result": "pass"}]}}}}
            session.add(am.ApprovalDecision(id="decision", request_id="approval", user_id="owner",
                user_name="Reviewer", decision="approve", note="Reviewed this fixed delivery", created_at=self.at,
                gate_snapshot={"evidence": [{"kind": "check", "title": "Frozen test", "summary": "Test evidence",
                                             "verification": {"state": "passed"}},
                                            {"kind": "text", "value": "PRIVATE_TRANSCRIPT"}]}))
            await session.commit()
        value = (await self.export()).json()["markdown"]
        for expected in ("已通过", "Reviewer", "Reviewed this fixed delivery", "Recorded check", "Frozen test", "2026",
                         "Recorded reviewer", "报告绑定的需求版本：2"):
            self.assertIn(expected, value)
        self.assertNotIn("WRONG", value)
        self.assertNotIn("PRIVATE", value)

    async def test_missing_approval_and_file_are_explicit_and_read_only(self):
        async with self.sessions() as session:
            await session.delete(await session.get(am.ApprovalRequest, "approval"))
            await session.delete(await session.get(models.Attachment, "output"))
            await session.commit()
        response = await self.export()
        self.assertEqual(response.status_code, 200)
        value = response.json()["markdown"]
        self.assertIn("验收状态：未记录", value)
        self.assertIn("文件记录缺失或不可访问", value)
        self.assertIn("不使用当前需求标准伪造历史基线", value)
        async with self.sessions() as session:
            self.assertIsNone(await session.get(am.ApprovalRequest, "approval"))
            task = await session.get(models.Task, "task")
            self.assertIsNone(task.reviewed_at)
            self.assertEqual(task.requirement_version, 3)
            self.assertEqual(len((await session.scalars(select(am.ArtifactVersion))).all()), 2)

    async def test_shared_requirement_does_not_grant_execution_export(self):
        self.assertEqual((await self.export("colleague")).status_code, 403)
        self.assertEqual((await self.export("stranger")).status_code, 404)
        self.assertEqual((await self.export("missing")).status_code, 401)

    async def test_account_switch_or_revocation_invalidates_authenticated_identity(self):
        for change in ("switch", "version", "inactive", "deleted", "revoked"):
            async with self.sessions() as session:
                client = await session.get(models.Client, "owner")
                client.user_ref = "owner"; client.auth_version = 1; client.revoked_at = None
                user = await session.get(models.User, "owner")
                user.is_active = True
                user.account_deleted_at = None
                if change == "switch": client.user_ref = "stranger"
                elif change == "version": client.auth_version = 2
                elif change == "inactive": user.is_active = False
                elif change == "deleted": user.account_deleted_at = self.at
                else: client.revoked_at = self.at
                await session.commit()
            with self.subTest(change=change):
                self.assertEqual((await self.export()).status_code, 401)

    async def test_stale_or_invalid_expectations_fail(self):
        for query, status in (({"artifactVersionId": "old-artifact"}, 409),
                              ({"requirementVersion": 2}, 409), ({"requirementVersion": 0}, 422)):
            with self.subTest(query=query):
                self.assertEqual((await self.export(**query)).status_code, status)

    async def test_archived_requirement_remains_exportable(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "task")
            task.archived_at = self.at
            await session.commit()
        response = await self.export()
        self.assertEqual(response.status_code, 200)
        self.assertIn("已归档", response.json()["markdown"])

    async def test_missing_delivery_does_not_synthesize_one(self):
        async with self.sessions() as session:
            for row in (await session.scalars(select(am.ArtifactVersion))).all():
                await session.delete(row)
            await session.commit()
        self.assertEqual((await self.export()).status_code, 409)

    async def test_markdown_and_links_cannot_embed_active_content_or_download_tokens(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "task")
            task.requirement_content = {"title": "../CON", "note": "![image](https://example.com/x)\n<script>alert(1)</script>"}
            artifact = await session.get(am.ArtifactVersion, "artifact")
            artifact.url = "https://example.com/output?ticket=PRIVATE_DOWNLOAD_TOKEN"
            await session.commit()
        value = (await self.export()).json()
        self.assertNotIn("/", value["filename"])
        self.assertNotIn("<script>", value["markdown"])
        self.assertNotIn("![image]", value["markdown"])
        self.assertNotIn("PRIVATE", value["markdown"])
        self.assertIn("&lt;script&gt;", value["markdown"])

    async def test_runtime_attribution_requires_matching_completed_execution(self):
        async with self.sessions() as session:
            session.add(am.ExecutionSession(id="execution", task_id="task", ref="execution-ref", state="done",
                engine="confirmed-agent", model="confirmed-model", finished_at=self.at - timedelta(seconds=1),
                updated_at=self.at - timedelta(seconds=1), metadata_={"executionIdentity": {"agentSessionId": "actual-session"},
                                                                    "credentials": "PRIVATE_EXECUTION_CREDENTIAL"}))
            await session.commit()
        value = (await self.export()).json()["markdown"]
        self.assertIn("confirmed\\-agent", value)
        self.assertIn("confirmed\\-model", value)
        self.assertNotIn("PRIVATE", value)
        async with self.sessions() as session:
            row = await session.get(am.ExecutionSession, "execution")
            row.updated_at = self.at + timedelta(seconds=1)
            row.model = "later-model"
            await session.commit()
        value = (await self.export()).json()["markdown"]
        self.assertNotIn("later", value)
        self.assertNotIn("confirmed", value)

    async def test_local_model_reference_is_not_exported(self):
        async with self.sessions() as session:
            session.add(am.ExecutionSession(task_id="task", ref="execution-ref", state="done", model="local:PRIVATE_LOCAL_MODEL",
                finished_at=self.at - timedelta(seconds=1), updated_at=self.at - timedelta(seconds=1),
                metadata_={"executionIdentity": {"agentSessionId": "actual-session"}}))
            await session.commit()
        value = (await self.export()).json()["markdown"]
        self.assertNotIn("PRIVATE", value)
        self.assertNotIn("local:", value)

    async def test_legacy_manifest_uses_shared_classification_and_does_not_invent_validation(self):
        async with self.sessions() as session:
            artifact = await session.get(am.ArtifactVersion, "artifact")
            artifact.manifest = {"files": [
                {"id": "output", "name": "result.md", "validation": {"state": "passed"}},
                {"id": "private", "name": ".env"},
            ]}
            await session.commit()
        value = (await self.export()).json()["markdown"]
        self.assertIn("result\\.md", value)
        self.assertIn("unverified", value)
        self.assertNotIn("passed", value)
        self.assertNotIn(".env", value)

    async def test_code_delivery_uses_commit_without_invented_attachment(self):
        async with self.sessions() as session:
            artifact = await session.get(am.ArtifactVersion, "artifact")
            artifact.kind = "code"
            artifact.commit_sha = "abc123"
            artifact.url = "https://example.com/commits/abc123"
            artifact.manifest = {}
            await session.commit()
        value = (await self.export()).json()["markdown"]
        self.assertIn("代码提交：abc123", value)
        self.assertIn("[成果链接](https://example.com/commits/abc123)", value)
        self.assertNotIn("文件记录缺失", value)

    async def test_mismatched_gate_evidence_is_not_relabelled_as_current_validation(self):
        async with self.sessions() as session:
            session.add(am.ApprovalDecision(request_id="approval", user_id="owner", user_name="Reviewer",
                decision="approve", gate_snapshot={"subject": {"artifactVersionId": "old-artifact"},
                    "evidence": [{"kind": "check", "title": "WRONG_VERSION_VALIDATION",
                                  "verification": {"state": "passed"}}]}))
            await session.commit()
        value = (await self.export()).json()["markdown"]
        self.assertNotIn("WRONG", value)
        self.assertIn("未记录逐项验证结果", value)

    async def test_concurrent_delivery_and_approval_commit_cannot_mix_snapshot(self):
        original = summary.release_control.latest_artifact

        async def publish_next(session, tid, **kwargs):
            async with self.sessions() as writer:
                task = await writer.get(models.Task, "task")
                task.requirement_version = 4
                task.requirement_content = {"title": "New requirement", "note": "NEW_BACKGROUND"}
                request = await writer.get(am.ApprovalRequest, "approval")
                request.status = "approved"
                writer.add(am.ApprovalDecision(request_id="approval", user_id="owner", user_name="NEW_REVIEWER",
                                               decision="approve", note="NEW_REVIEW_NOTE"))
                writer.add(am.ArtifactVersion(id="next-artifact", task_id="task", seq=3,
                                               kind="text", checksum="next", manifest={"text": "NEW_DELIVERY"}))
                await writer.commit()
            return await original(session, tid, **kwargs)

        with patch.object(summary.release_control, "latest_artifact", publish_next):
            response = await self.export()
        self.assertEqual(response.status_code, 200, response.text)
        value = response.json()
        self.assertEqual(value["artifactVersionId"], "artifact")
        self.assertEqual(value["requirementVersion"], 3)
        self.assertIn("待验收", value["markdown"])
        self.assertNotIn("NEW", value["markdown"])
        latest = (await self.export()).json()
        self.assertEqual(latest["artifactVersionId"], "next-artifact")
        self.assertEqual(latest["requirementVersion"], 4)

    async def test_snapshot_does_not_leave_connection_in_transaction(self):
        await self.export()
        async with self.engine.connect() as connection:
            await connection.execute(text("UPDATE task SET priority = 'normal' WHERE id = 'task'"))
            await connection.commit()

    async def test_export_issues_no_mutating_sql_or_creates_approval(self):
        writes = []

        def observe(connection, cursor, statement, parameters, context, many):
            if statement.lstrip().split(" ", 1)[0].upper() in {"INSERT", "UPDATE", "DELETE", "REPLACE"}:
                writes.append(statement)

        event.listen(self.engine.sync_engine, "before_cursor_execute", observe)
        try:
            self.assertEqual((await self.export()).status_code, 200)
            self.assertEqual(writes, [])
        finally:
            event.remove(self.engine.sync_engine, "before_cursor_execute", observe)


if __name__ == "__main__":
    unittest.main()
