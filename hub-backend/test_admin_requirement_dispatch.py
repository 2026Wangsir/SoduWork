"""Real HTTP/RBAC + isolated SQL state for the shared requirement dispatcher.

Only the external Agent/workspace boundary is deterministic. No user data,
Runner process, model endpoint or real workspace is touched.
"""
import importlib
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
import httpx
from fastapi import FastAPI, Request
from sqlalchemy import create_engine, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from app import models, automation_models as am
from app.api import admin, tasks
from app.auth import sign_token
from app.db import Base, get_session
from app.deps import current_client
from app.services import ai_exec, dispatch_identity, task_dispatch

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


class AdminRequirementDispatchTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="soduwork-admin-dispatch-")
        self.addCleanup(self.tmp.cleanup)
        database = (Path(self.tmp.name).resolve() / "fixture.db").as_posix()
        # Build the complete fresh schema synchronously before opening async
        # sessions; hundreds of DDL thread handoffs can exhaust Windows CI's
        # module deadline. Each test still owns an independent database.
        schema_engine = create_engine("sqlite:///" + database)
        try:
            Base.metadata.create_all(schema_engine)
        finally:
            schema_engine.dispose()
        self.engine = create_async_engine("sqlite+aiosqlite:///" + database)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.sessions() as session:
            session.add_all([models.OrgUnit(id="team", name="Team"), models.OrgUnit(id="outside", name="Outside"),
                models.Role(id="operator", name="Operator", permissions=["task.view", "task.dispatch", "plugin.run"]),
                models.Role(id="reader", name="Reader", permissions=["task.view"])])
            for uid, org, role in (("admin", "team", "operator"), ("reader", "team", "reader"),
                                   ("owner", "team", "reader"), ("outside", "outside", "operator")):
                session.add(models.User(id=uid, username=uid, display_name=uid, org_id=org, role_id=role,
                                        is_active=True, auth_version=1))
                session.add(models.Client(id=uid, user_ref=uid, auth_state="active"))
            session.add(models.Project(id="project", name="Project", org_id="team"))
            await session.commit()
        self.app = FastAPI()
        self.app.include_router(admin.router)
        self.app.include_router(tasks.router)

        async def db():
            async with self.sessions() as session:
                yield session

        async def device(request: Request):
            async with self.sessions() as session:
                return await session.get(models.Client, request.headers.get("X-Test-Device", "owner"))

        self.app.dependency_overrides[get_session] = db
        self.app.dependency_overrides[current_client] = device
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://isolated")
        self.calls = []

        def dispatch(ctx, task, files, picked, extra):
            self.calls.append({"task": task.id, "ctx": ctx, "extra": extra})
            return {"ok": True, "issueId": dispatch_identity.execution_ref(extra["dispatchId"]),
                    "provider": "local", "assigneeId": "local:pi", "assigneeCli": "pi", "state": "running"}

        self.prepare = AsyncMock(side_effect=lambda session, client, ctx, *a: (ctx, {"owner": client.id}))
        self.git = AsyncMock(side_effect=lambda session, ctx, task, **kw: {**ctx, "owner": task.owner_client_id})
        self.patches = [
            patch("app.realtime.hub.publish", new_callable=AsyncMock),
            patch("app.services.zero_work_route.try_route", new=AsyncMock(return_value=None)),
            patch.object(ai_exec, "load", new=AsyncMock(return_value={"provider": "local"})),
            patch.object(ai_exec, "with_task_git", new=self.git),
            patch.object(ai_exec, "resolve_default_sync", return_value={"id": "local:pi", "cli": "pi", "name": "Pi"}),
            patch("app.services.task_execution_model.prepare", new=self.prepare),
            patch.object(ai_exec, "with_project_context", new=AsyncMock(side_effect=lambda session, extra, *a: extra)),
            patch.object(ai_exec, "dispatch_sync", side_effect=dispatch),
            patch.object(task_dispatch, "_settle_work_dir", new=AsyncMock(return_value={"ok": True, "dir": "isolated"})),
            patch.object(task_dispatch, "_attach_skills", new=AsyncMock()),
        ]
        for item in self.patches:
            item.start()

    async def asyncTearDown(self):
        for item in reversed(self.patches):
            item.stop()
        await self.http.aclose()
        await self.engine.dispose()

    async def create(self, tid="requirement", **kwargs):
        async with self.sessions() as session:
            task = models.Task(id=tid, title=tid, owner_client_id=kwargs.pop("owner_client_id", "owner"),
                               status=kwargs.pop("status", "todo"), **kwargs)
            session.add(task)
            await session.commit()
        return tid

    async def post(self, tid, who="admin"):
        return await self.http.post(f"/api/v1/admin/tasks/{tid}/ai-dispatch",
                                    headers={"Authorization": "Bearer " + sign_token(who, 1)})

    async def test_admin_and_device_share_one_attempt_owner_context_admin_audit(self):
        tid = await self.create()
        first = await self.post(tid)
        self.assertEqual(first.status_code, 200, first.text)
        second = await self.post(tid)
        device = await self.http.post(f"/api/v1/tasks/{tid}/ai-dispatch", json={})
        self.assertEqual(second.status_code, 200, second.text)
        self.assertTrue(second.json()["already"])
        self.assertEqual(first.json()["issueId"], device.json()["issueId"])
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.calls[0]["ctx"]["owner"], "owner")
        self.assertEqual(self.calls[0]["extra"]["agentExecution"]["owner"], "owner")
        async with self.sessions() as session:
            logs = (await session.execute(select(models.AuditLog).where(models.AuditLog.action == "task.ai_dispatch"))).scalars().all()
            self.assertEqual([row.actor_id for row in logs], ["admin"])
            rows = (await session.execute(select(am.ExecutionSession))).scalars().all()
            self.assertEqual(len(rows), 1)
            self.assertEqual(rows[0].task_id, tid)

    async def test_runner_dispatch_correlates_only_the_authorized_queue_turn(self):
        scope = {"conversationId": "chat", "turnId": "turn"}
        tid = await self.create(work_routing={"conversationTurn": {
            **scope, "executor": "dispatch", "state": "running"}})
        response = await self.http.post(f"/api/v1/tasks/{tid}/ai-dispatch", json={
            "conversationTurn": {**scope, "note": "Never copy arbitrary fields"},
            "executionContext": {"strategy": "direct"}})
        self.assertEqual(response.status_code, 200, response.text)
        async with self.sessions() as session:
            events = (await session.scalars(select(models.TaskEvent).where(
                models.TaskEvent.task_id == tid, models.TaskEvent.kind == "ai.dispatched"))).all()
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].detail["conversationTurn"], scope)
        from app.services.dispatch_instructions import confirmed_turn
        task = models.Task(work_routing={"conversationTurn": {**scope, "executor": "dispatch", "state": "running"}})
        for claimed in (None, {**scope, "turnId": "stale"}, {**scope, "conversationId": "other"}):
            self.assertEqual(confirmed_turn(task, claimed), {})
        task.work_routing = {"conversationTurn": {**scope, "executor": "dispatch", "state": "completed"}}
        self.assertEqual(confirmed_turn(task, scope), {})

    async def test_terminal_unclarified_and_active_conversation_are_not_dispatched(self):
        cases = [dict(archived_at=datetime.now(timezone.utc)), dict(triage_stage="intake"),
                 dict(triage_stage="clarifying"), dict(status="cancel"), dict(status="done"),
                 dict(work_routing={"conversationTurn": {"state": "running", "turnId": "turn"}})]
        for index, fields in enumerate(cases):
            tid = await self.create(str(index), **fields)
            with self.subTest(fields=fields):
                result = await self.post(tid)
                self.assertIn(result.status_code, (400, 409), result.text)
                result = await self.http.post(f"/api/v1/tasks/{tid}/ai-dispatch", json={})
                self.assertIn(result.status_code, (400, 409), result.text)
        self.assertFalse(self.calls)

    async def test_permissions_and_device_ownership_remain_distinct(self):
        tid = await self.create()
        self.assertEqual((await self.post(tid, "reader")).status_code, 403)
        self.assertEqual((await self.post(tid, "outside")).status_code, 403)
        self.assertEqual((await self.http.post(f"/api/v1/tasks/{tid}/ai-dispatch", json={},
                            headers={"X-Test-Device": "admin"})).status_code, 404)
        async with self.sessions() as session:
            owner = await session.get(models.Client, "owner")
            owner.auth_state = "revoked"
            await session.commit()
        self.assertEqual((await self.post(tid)).status_code, 409)
        self.assertFalse(self.calls)

    async def test_managed_project_cannot_fall_back_to_direct(self):
        tid = await self.create(project_id="project")
        result = await self.post(tid)
        self.assertEqual(result.status_code, 409, result.text)
        self.assertFalse(self.calls)
        async with self.sessions() as session:
            session.add(am.WorkflowRun(id="managed-run", task_id=tid, state="running",
                plugin_id="historical-plugin", plugin_version_id="historical-version", binding_id="historical-binding"))
            await session.commit()
        result = await self.post(tid)
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["runId"], "managed-run")
        self.assertTrue(result.json()["reused"])
        self.assertFalse(self.calls)

    async def test_uncertain_ack_does_not_start_second_execution(self):
        tid = await self.create()
        with patch.object(ai_exec, "dispatch_sync", return_value={"ok": False, "uncertain": True, "error": "lost ACK"}) as dispatch:
            first = await self.post(tid)
            second = await self.post(tid)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertTrue(first.json()["pending"])
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(second.json()["issueId"], first.json()["issueId"])
        self.assertEqual(dispatch.call_count, 1)

    async def test_active_unmanaged_workflow_cannot_be_downgraded_or_duplicated(self):
        tid = await self.create()
        async with self.sessions() as session:
            session.add(am.WorkflowRun(id="existing", task_id=tid, state="running",
                plugin_id="historical", plugin_version_id="historical", binding_id="historical"))
            await session.commit()
        for endpoint, body in (("admin/", {}), ("", {"executionContext": {"strategy": "direct"}})):
            result = await self.http.post(f"/api/v1/{endpoint}tasks/{tid}/ai-dispatch", json=body,
                headers={"Authorization": "Bearer " + sign_token("admin", 1)})
            self.assertEqual(result.status_code, 200, result.text)
            self.assertEqual(result.json()["runId"], "existing")
        self.assertFalse(self.calls)

    async def test_explicit_direct_choice_replaces_unstarted_workflow_selection(self):
        tid = await self.create(work_routing={
            'selectedStrategy': 'workflow', 'workflowBindingId': 'previous-binding',
            'executionContext': {'strategy': 'workflow', 'workflowBindingId': 'previous-binding'},
        })
        result = await self.http.post(f'/api/v1/tasks/{tid}/ai-dispatch',
                                     json={'executionContext': {'strategy': 'direct'}})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(len(self.calls), 1)
        async with self.sessions() as session:
            task = await session.get(models.Task, tid)
            self.assertEqual(task.work_routing['selectedStrategy'], 'direct')
            self.assertEqual(task.work_routing['workflowBindingId'], '')
            self.assertEqual(task.work_routing['executionContext']['strategy'], 'direct')

    async def test_starting_workflow_lease_prevents_direct_dispatch(self):
        from datetime import timedelta
        tid = await self.create()
        async with self.sessions() as session:
            session.add(am.ResourceLease(resource_kind="workflow-start", resource_key=tid, token="fixture",
                lease_until=datetime.now(timezone.utc) + timedelta(minutes=2)))
            await session.commit()
        result = await self.post(tid)
        self.assertEqual(result.status_code, 409, result.text)
        self.assertFalse(self.calls)

    async def test_admin_list_preserves_history_and_reports_real_execution_failure(self):
        tid = await self.create("failed")
        await self.create("archive", project_id="project", archived_at=datetime.now(timezone.utc))
        await self.create("cancel", project_id="project", status="cancel")
        await self.create("done", project_id="project", status="done")
        await self.create("intake", project_id="project", triage_stage="intake")
        async with self.sessions() as session:
            session.add(models.TaskEvent(task_id=tid, kind=ai_exec.EV_DISPATCH_FAILED, detail={"error": "blocked"}))
            await session.commit()
        headers = {"Authorization": "Bearer " + sign_token("admin", 1)}
        result = await self.http.get("/api/v1/admin/tasks", headers=headers)
        self.assertEqual(result.status_code, 200, result.text)
        rows = {row["id"]: row for row in result.json()}
        self.assertTrue(rows["archive"]["archivedAt"])
        self.assertEqual(rows["failed"]["ai"]["state"], "failed")
        self.assertTrue(rows["failed"]["canViewExecution"])
        project = (await self.http.get("/api/v1/admin/projects", headers=headers)).json()[0]
        self.assertEqual((project["total"], project["done"], project["closed"]), (2, 1, 2))
        detail = (await self.http.get("/api/v1/admin/projects/project", headers=headers)).json()
        self.assertEqual(len(detail["tasks"]), 4)

    async def test_project_creation_can_enter_intake_without_implicit_dispatch(self):
        result = await self.http.post("/api/v1/admin/projects/project/tasks", json={
            "title": "A requirement needing clarification", "target": "owner", "triageStage": "intake"},
            headers={"Authorization": "Bearer " + sign_token("admin", 1)})
        self.assertEqual(result.status_code, 200, result.text)
        self.assertEqual(result.json()["triageStage"], "intake")
        self.assertEqual((await self.post(result.json()["id"])).status_code, 409)
        self.assertFalse(self.calls)


if __name__ == "__main__":
    unittest.main()
