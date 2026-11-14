"""Account quota enforcement through real device, admin and proxy HTTP dependencies."""
import asyncio
import json
import os
import time
import unittest
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-quota-test-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-quota-test-admin")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import FastAPI
from sqlalchemy import event, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import (admin, ai_proxy, attachments, client_auth, clients, cloud_conversations,
                     config, personal_models, plugin_client_catalog, plugin_client_runs,
                     reports, tasks, usage)
from app.auth import sign_token
from app.db import get_session
from app.services import client_access, device_auth, rbac, usage_ledger
from tests.sqlite_schema import create_fresh_sqlite_schema


class TokenQuotaTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await create_fresh_sqlite_schema(connection, models.Base.metadata)
        self.user = models.User(id="quota-owner", username="quota-owner", org_id="quota-org")
        self.other = models.User(id="quota-other", username="quota-other", org_id="other-org")
        self.operator = models.User(id="quota-admin", username="quota-admin", is_super=True)
        self.devices = [models.Client(id="quota-device-1"), models.Client(id="quota-device-2")]
        async with self.sessions() as session:
            session.add_all([models.OrgUnit(id="quota-org", name="Quota org"),
                             models.OrgUnit(id="other-org", name="Other org"),
                             self.user, self.other, self.operator])
            for client in self.devices:
                device_auth.activate(client, self.user)
                session.add(client)
            await session.commit()
        self.headers = {"Authorization": "Device " + device_auth.issue_session(self.devices[0])[0]}
        self.second_headers = {"Authorization": "Device " + device_auth.issue_session(self.devices[1])[0]}
        self.admin_headers = {"Authorization": "Bearer " + sign_token(self.operator.id)}
        app = FastAPI()
        for router in (admin.router, client_auth.router, clients.router, tasks.router, usage.router,
                       ai_proxy.router, config.router, personal_models.router,
                       plugin_client_catalog.router, plugin_client_runs.router,
                       attachments.router, cloud_conversations.router, reports.router):
            app.include_router(router)

        async def isolated_session():
            async with self.sessions() as session:
                yield session
        app.dependency_overrides[get_session] = isolated_session
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://quota.test")
        client_access._policy_cache = None

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()
        client_access._policy_cache = None

    async def policy(self, limit=100, enabled=True):
        response = await self.http.put("/api/v1/admin/client-auth-policy", headers=self.admin_headers,
            json={"tokenLimitEnabled": enabled, "monthlyTokenLimit": limit})
        self.assertEqual(response.status_code, 200, response.text)

    async def override(self, mode, limit=0, uid="quota-owner"):
        response = await self.http.patch("/api/v1/admin/users/" + uid, headers=self.admin_headers,
            json={"tokenQuota": {"mode": mode, "limit": limit}})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def report(self, total, *, headers=None, key="conversation"):
        return await self.http.post("/api/v1/usage/events", headers=headers or self.headers,
            json={"sourceId": key, "usage": {"input": total}})

    async def test_existing_proxy_tickets_cannot_bypass_quota(self):
        ticket = device_auth.issue_proxy_ticket(self.devices[0])[0]
        await self.policy(10)
        self.assertEqual((await self.report(10)).status_code, 200)
        with patch.object(ai_proxy.model_catalog, "usable", new=AsyncMock()) as catalog:
            for route in ("chat/completions", "responses", "images/generations", "videos/generations"):
                response = await self.http.post("/api/v1/ai-proxy/v1/" + route,
                    headers={"Authorization": "Bearer " + ticket}, json={"model": "fixture"})
                self.assertEqual(response.status_code, 403, response.text)
                self.assertEqual(response.json()["detail"]["code"], "TOKEN_QUOTA_EXCEEDED")
            catalog.assert_not_awaited()

    async def test_exceeded_quota_preserves_business_reads_settings_and_task_creation(self):
        from app.services import device_connections
        await self.policy(10)
        await self.report(10)
        with patch.object(device_connections, "disconnect", new=AsyncMock()) as disconnect, \
             patch.object(client_access, "monthly_tokens", wraps=client_access.monthly_tokens) as monthly:
            for route in ("/api/v1/tasks", "/api/v1/config", "/api/v1/plugins/catalog"):
                response = await self.http.get(route, headers=self.headers)
                self.assertEqual(response.status_code, 200, (route, response.text))
            saved = await self.http.put("/api/v1/config", headers=self.headers, json={"deskView": "history"})
            self.assertEqual(saved.status_code, 200, saved.text)
            self.assertEqual(saved.json()["deskView"], "history")
            created = await self.http.post("/api/v1/tasks", headers=self.headers,
                json={"id": "manual-after-quota", "title": "Manual work remains available"})
            self.assertEqual(created.status_code, 200, created.text)
            monthly.assert_not_awaited()
            denied = await self.http.get("/api/v1/client-auth/authorize-ai", headers=self.headers)
            self.assertEqual(denied.status_code, 403)
            self.assertEqual(denied.json()["detail"]["code"], "TOKEN_QUOTA_EXCEEDED")
            monthly.assert_awaited_once()
            disconnect.assert_not_awaited()
        status = await self.http.get("/api/v1/client-auth/me", headers=self.headers)
        self.assertEqual(status.status_code, 200)
        self.assertTrue(status.json()["quota"]["exceeded"])

    async def test_ai_entry_points_remain_closed_after_business_access_is_restored(self):
        await self.override("limited", 0)
        for route in ("/api/v1/ai-proxy/config", "/api/v1/ai-proxy/media/config"):
            response = await self.http.get(route, headers=self.headers)
            self.assertEqual(response.status_code, 403, (route, response.text))
            self.assertEqual(response.json()["detail"]["code"], "TOKEN_QUOTA_EXCEEDED")
        for route in ("/api/v1/tasks/parse", "/api/v1/my-models/test",
                      "/api/v1/tasks/absent/plugin-runs", "/api/v1/conversations/check/images",
                      "/api/v1/reports/generate", "/api/v1/ai-proxy/vision/analyze"):
            response = await self.http.post(route, headers=self.headers, json={})
            self.assertEqual(response.status_code, 403, (route, response.text))
            self.assertEqual(response.json()["detail"]["code"], "TOKEN_QUOTA_EXCEEDED")
        response = await self.http.post("/api/v1/cloud-conversations/quota-check", headers=self.headers,
            data={"options": "{}"})
        self.assertEqual(response.status_code, 403, response.text)
        self.assertEqual(response.json()["detail"]["code"], "TOKEN_QUOTA_EXCEEDED")

    async def test_exceeded_account_still_reports_final_usage_without_double_counting(self):
        await self.policy(10)
        for total in (10, 25, 25):
            response = await self.report(total)
            self.assertEqual(response.status_code, 200, response.text)
            self.assertTrue(response.json()["quota"]["exceeded"])
        async with self.sessions() as session:
            self.assertEqual(await client_access.monthly_tokens(session, self.user.id), 25)
        denied = await self.http.get("/api/v1/client-auth/authorize-ai", headers=self.headers)
        self.assertEqual(denied.status_code, 403)
        invalid = await self.http.post("/api/v1/usage/events", headers={"Authorization": "Device invalid"},
            json={"sourceId": "invalid", "usage": {"total": 100}})
        self.assertEqual(invalid.status_code, 401)

    async def test_exceeded_trusted_device_renews_accounting_identity_but_cannot_start_work(self):
        await self.override("limited", 0)
        secret = "isolated-accounting-renewal-device-key"
        async with self.sessions() as session:
            client = await session.get(models.Client, self.devices[0].id)
            client.secret_hash = device_auth.hash_secret(secret)
            await session.commit()
        renewed = await self.http.post("/api/v1/clients/enroll", headers={"X-Device-Key": secret},
            json={"device": self.devices[0].id})
        self.assertEqual(renewed.status_code, 200, renewed.text)
        self.assertTrue(renewed.json()["quota"]["exceeded"])
        headers = {"Authorization": "Device " + renewed.json()["session"]}
        self.assertEqual((await self.report(25, headers=headers)).status_code, 200)
        self.assertEqual((await self.http.get("/api/v1/client-auth/authorize-ai", headers=headers)).status_code, 403)

    async def test_quota_denied_queued_turn_can_settle_without_starting(self):
        await self.override("limited", 0)
        scope = {"turnId": "queued-turn", "conversationId": "quota-conversation", "executor": "native"}
        async with self.sessions() as session:
            session.add(models.Task(id="quota-queued-task", title="Queued quota task",
                owner_client_id=self.devices[0].id, owner_user_id=self.user.id, status="todo",
                work_routing={"conversationTurn": {**scope, "state": "queued"}}))
            await session.commit()
        route = "/api/v1/tasks/quota-queued-task/conversation-turn"
        blocked = await self.http.post(route, headers=self.headers, json={**scope, "action": "start"})
        self.assertEqual(blocked.status_code, 403, blocked.text)
        ended = await self.http.post(route, headers=self.headers, json={**scope, "action": "fail"})
        self.assertEqual(ended.status_code, 200, ended.text)
        self.assertEqual(ended.json()["turn"]["state"], "failed")
        retry = await self.http.post(route, headers=self.headers, json={**scope, "action": "prepare"})
        self.assertEqual(retry.status_code, 403, retry.text)

    async def test_device_owned_native_receipts_do_not_consume_platform_model_allowance(self):
        from app.agent_catalog import AGENTS
        await self.override("limited", 0)
        for agent, spec in AGENTS.items():
            if spec.get("modelMode") != "managed":
                continue
            with self.subTest(agent=agent):
                tid = "private-receipt-" + agent
                async with self.sessions() as session:
                    session.add(models.Task(id=tid, title="Local execution receipt", status="todo",
                        owner_client_id=self.devices[0].id, owner_user_id=self.user.id,
                        work_routing={"executionSubmissionMode": "manual"}))
                    await session.commit()
                scope = {"conversationId": "local-conversation", "turnId": "local-turn",
                         "executor": "native", "modelSource": "device", "agentId": "local:" + agent}
                for action in ("prepare", "start", "started", "complete"):
                    response = await self.http.post("/api/v1/tasks/" + tid + "/conversation-turn",
                        headers=self.headers, json={**scope, "action": action})
                    self.assertEqual(response.status_code, 200, response.text)
                    self.assertEqual(response.json()["turn"]["modelSource"], "device")
                    self.assertEqual(response.json()["turn"]["modelAgentId"], agent)
                self.assertEqual(response.json()["turn"]["state"], "completed")
                retagged = await self.http.post("/api/v1/tasks/" + tid + "/conversation-turn",
                    headers=self.headers, json={**scope, "action": "prepare", "modelSource": "managed"})
                self.assertEqual(retagged.status_code, 409, retagged.text)
                # A later managed turn cannot inherit an earlier device-owned source.
                managed = await self.http.post("/api/v1/tasks/" + tid + "/conversation-turn",
                    headers=self.headers, json={**scope, "turnId": "managed-next", "action": "prepare",
                                               "modelSource": "managed"})
                self.assertEqual(managed.status_code, 403, managed.text)
        self.assertEqual((await self.http.get("/api/v1/client-auth/authorize-ai", headers=self.headers)).status_code, 403)
        async with self.sessions() as session:
            self.assertEqual(await client_access.monthly_tokens(session, self.user.id), 0)

    async def test_device_receipt_source_cannot_be_retagged_or_used_for_remote_execution(self):
        await self.override("unlimited")
        tid = "immutable-model-source"
        async with self.sessions() as session:
            session.add(models.Task(id=tid, title="Immutable source", status="todo",
                owner_client_id=self.devices[0].id, owner_user_id=self.user.id))
            await session.commit()
        route = "/api/v1/tasks/" + tid + "/conversation-turn"
        scope = {"conversationId": "source-conversation", "turnId": "source-turn", "executor": "native"}
        prepared = await self.http.post(route, headers=self.headers, json={**scope, "action": "prepare"})
        self.assertEqual(prepared.status_code, 200, prepared.text)
        await self.override("limited", 0)
        retagged = await self.http.post(route, headers=self.headers, json={**scope, "action": "start",
            "modelSource": "device", "agentId": "local:pi"})
        self.assertEqual(retagged.status_code, 409, retagged.text)
        for patch_body in ({"executor": "dispatch"}, {"executor": "workflow"},
                           {"agentId": "local:codex"}, {"agentId": "local:claude"},
                           {"agentId": "runner:remote:pi"}, {"model": "local:model-private"}):
            rejected = await self.http.post(route, headers=self.headers, json={**scope, "turnId": "new-turn",
                "action": "prepare", "modelSource": "device", "agentId": "local:pi", **patch_body})
            self.assertEqual(rejected.status_code, 422, rejected.text)
            self.assertNotIn("local:model-private", rejected.text)
        for route, body in (("/api/v1/tasks/parse", {"modelSource": "device"}),
                            ("/api/v1/cloud-conversations/quota-check", None)):
            response = await self.http.post(route, headers=self.headers,
                **({"json": body} if body is not None else {"data": {"options": json.dumps({"modelSource": "device"})}}))
            self.assertEqual(response.status_code, 403, response.text)

    async def test_device_receipts_keep_account_and_device_ownership_checks(self):
        await self.override("limited", 0)
        async with self.sessions() as session:
            session.add(models.Task(id="private-owned-task", title="Owned receipt", status="todo",
                owner_client_id=self.devices[0].id, owner_user_id=self.user.id))
            await session.commit()
        body = {"action": "prepare", "conversationId": "owned-chat", "turnId": "owned-turn",
                "executor": "native", "modelSource": "device", "agentId": "local:pi"}
        route = "/api/v1/tasks/private-owned-task/conversation-turn"
        other_device = await self.http.post(route, headers=self.second_headers, json=body)
        self.assertEqual(other_device.status_code, 404, other_device.text)
        async with self.sessions() as session:
            user = await session.get(models.User, self.user.id)
            user.is_active = False
            await session.commit()
        inactive = await self.http.post(route, headers=self.headers, json=body)
        self.assertEqual(inactive.status_code, 403, inactive.text)

    async def test_native_receipts_reject_private_references_with_managed_or_legacy_sources(self):
        await self.override("unlimited")
        async with self.sessions() as session:
            session.add(models.Task(id="private-reference-task", title="Private reference", status="todo",
                owner_client_id=self.devices[0].id, owner_user_id=self.user.id))
            await session.commit()
        route = "/api/v1/tasks/private-reference-task/conversation-turn"
        for model in ("local:model-private", "image::device:provider::local:model-private"):
            for source in ({}, {"modelSource": "managed"}):
                with self.subTest(model=model, source=source):
                    response = await self.http.post(route, headers=self.headers, json={"action": "prepare",
                        "conversationId": "private-chat", "turnId": "private-turn", "executor": "native",
                        "executionChoice": "native", "agentId": "local:pi", "model": model, **source})
                    self.assertEqual(response.status_code, 422, response.text)
                    self.assertNotIn(model, response.text)
        async with self.sessions() as session:
            task = await session.get(models.Task, "private-reference-task")
            self.assertNotIn("conversationTurn", task.work_routing or {})
        ordinary = await self.http.post(route, headers=self.headers, json={"action": "prepare",
            "conversationId": "hub-chat", "turnId": "hub-turn", "executor": "native",
            "executionChoice": "native", "agentId": "local:pi", "model": "image::device:provider::ordinary-hub-model"})
        self.assertEqual(ordinary.status_code, 200, ordinary.text)
        self.assertEqual(ordinary.json()["task"]["workRouting"]["executionContext"]["model"],
                         "image::device:provider::ordinary-hub-model")

    async def test_multiple_devices_share_user_quota_and_people_have_distinct_limits(self):
        await self.policy(1000)
        await self.override("limited", 100)
        await self.override("limited", 200, uid=self.other.id)
        for headers in (self.headers, self.second_headers):
            response = await self.report(60, headers=headers)
            self.assertEqual(response.status_code, 200)
        response = await self.http.get("/api/v1/client-auth/authorize-ai", headers=self.second_headers)
        self.assertEqual(response.status_code, 403)
        self.assertEqual(response.json()["detail"]["quota"]["used"], 120)
        async with self.sessions() as session:
            other = await client_access.quota_status(session, self.other.id)
            self.assertEqual((other["limit"], other["used"], other["exceeded"]), (200, 0, False))

    async def test_zero_unlimited_inherit_and_raising_limit_restore_access(self):
        await self.policy(10)
        await self.report(10)
        await self.override("limited", 20)
        self.assertEqual((await self.http.get("/api/v1/client-auth/authorize-ai", headers=self.headers)).status_code, 200)
        await self.override("unlimited")
        self.assertFalse((await self.http.get("/api/v1/client-auth/authorize-ai", headers=self.headers)).json()["quota"]["enabled"])
        await self.override("inherit")
        self.assertEqual((await self.http.get("/api/v1/client-auth/authorize-ai", headers=self.headers)).status_code, 403)
        await self.policy(0, enabled=False)
        await self.override("limited", 0)
        self.assertEqual((await self.http.get("/api/v1/client-auth/authorize-ai", headers=self.headers)).status_code, 403)

    async def test_policy_updates_are_visible_without_process_cache_invalidation(self):
        client_access._policy_cache = (time.monotonic() + 10000, dict(client_access.DEFAULT_POLICY))
        async with self.sessions() as reader:
            self.assertFalse((await client_access.quota_status(reader, self.user.id))["enabled"])
            async with self.sessions() as writer:
                writer.add(models.AppSetting(key=client_access.POLICY_KEY,
                    value=json.dumps({"tokenLimitEnabled": True, "monthlyTokenLimit": 10})))
                await usage_ledger.from_client(writer, self.devices[0],
                    {"sourceId": "fresh-policy", "usage": {"input": 10}})
                await writer.commit()
            self.assertTrue((await client_access.quota_status(reader, self.user.id))["exceeded"])

    async def test_partial_policy_update_preserves_another_workers_committed_rules(self):
        await self.policy(100)
        client_access._policy_cache = (time.monotonic() + 10000, dict(client_access.DEFAULT_POLICY))
        response = await self.http.put("/api/v1/admin/client-auth-policy", headers=self.admin_headers,
            json={"monthlyTokenLimit": 200})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["tokenLimitEnabled"])
        self.assertEqual(response.json()["monthlyTokenLimit"], 200)
        client_access._policy_cache = (time.monotonic() + 10000, dict(client_access.DEFAULT_POLICY))
        loaded = await self.http.get("/api/v1/admin/client-auth-policy", headers=self.admin_headers)
        self.assertTrue(loaded.json()["tokenLimitEnabled"])

    async def test_month_boundaries_and_future_month_do_not_move_quota(self):
        zone = timezone(timedelta(hours=8))
        start = datetime.now(zone).replace(day=1, hour=0, minute=0, second=0, microsecond=0)
        next_month = (start.replace(day=28) + timedelta(days=4)).replace(day=1)
        async with self.sessions() as session:
            for total, at in ((40, start - timedelta(seconds=1)), (70, start), (90, next_month)):
                await usage_ledger.from_client(session, self.devices[0], {"sourceId": "boundary",
                    "usage": {"input": total}, "occurredAt": at.isoformat()})
            await session.commit()
            self.assertEqual(await client_access.monthly_tokens(session, self.user.id), 30)

    async def test_invalid_limits_and_cross_scope_edits_are_rejected(self):
        for mode, limit in (("bad", 10), ("limited", -1), ("limited", True),
                            ("limited", 1.5), ("limited", 10_000_000_000_001)):
            response = await self.http.patch("/api/v1/admin/users/" + self.user.id,
                headers=self.admin_headers, json={"tokenQuota": {"mode": mode, "limit": limit}})
            self.assertEqual(response.status_code, 422, response.text)
        async with self.sessions() as session:
            session.add(models.Role(id="quota-role", name="Scoped admin", permissions=["user.manage"]))
            scoped = models.User(id="quota-scoped", username="quota-scoped", org_id="quota-org", role_id="quota-role")
            session.add(scoped)
            await session.commit()
        response = await self.http.patch("/api/v1/admin/users/" + self.other.id,
            headers={"Authorization": "Bearer " + sign_token("quota-scoped")},
            json={"tokenQuota": {"mode": "unlimited"}})
        self.assertEqual(response.status_code, 403, response.text)

    async def test_user_creation_and_unrelated_edits_preserve_override(self):
        response = await self.http.post("/api/v1/admin/users", headers=self.admin_headers,
            json={"username": "quota-new", "password": "test-password", "orgId": "quota-org",
                  "tokenQuota": {"mode": "limited", "limit": 500}})
        self.assertEqual(response.status_code, 200, response.text)
        uid = response.json()["id"]
        response = await self.http.patch("/api/v1/admin/users/" + uid, headers=self.admin_headers,
            json={"displayName": "Updated name"})
        self.assertEqual(response.json()["tokenQuota"], {"mode": "limited", "limit": 500})
        listed = (await self.http.get("/api/v1/admin/users", headers=self.admin_headers)).json()
        self.assertEqual(next(row for row in listed if row["id"] == uid)["tokenQuota"]["limit"], 500)

    async def test_concurrent_devices_cannot_reuse_a_stale_allow_after_limit_changes(self):
        await self.override("limited", 0)
        replies = await asyncio.gather(*(self.http.get("/api/v1/client-auth/authorize-ai",
            headers=self.headers if index % 2 else self.second_headers) for index in range(20)))
        self.assertTrue(all(reply.status_code == 403 for reply in replies))
        await self.override("limited", 100)
        replies = await asyncio.gather(*(self.http.get("/api/v1/client-auth/authorize-ai",
            headers=self.headers if index % 2 else self.second_headers) for index in range(20)))
        self.assertTrue(all(reply.status_code == 200 for reply in replies))

    async def test_unlimited_device_admission_has_no_extra_query_and_admin_listing_is_batched(self):
        await self.policy(100)
        await self.override("unlimited")
        await self.http.get("/api/v1/client-auth/authorize-ai", headers=self.headers)
        statements = []
        def capture(_conn, _cursor, statement, _params, _context, _many):
            statements.append(statement)
        event.listen(self.engine.sync_engine, "before_cursor_execute", capture)
        try:
            reply = await self.http.get("/api/v1/client-auth/authorize-ai", headers=self.headers)
            self.assertEqual(reply.status_code, 200)
            self.assertEqual(reply.headers["Cache-Control"], "private, no-store")
            self.assertEqual(len(statements), 1)
            self.assertNotIn("ai_usage_daily", statements[0])
            statements.clear()
            async with self.sessions() as session:
                users = await rbac.list_users(session, None)
                self.assertEqual(len(users), 3)
                self.assertEqual(len(statements), 2)
        finally:
            event.remove(self.engine.sync_engine, "before_cursor_execute", capture)

    async def test_admission_queries_are_bounded_and_use_month_indexes(self):
        await self.policy(100)
        statements = []
        def capture(_conn, _cursor, statement, params, _context, _many):
            statements.append((statement, params))
        event.listen(self.engine.sync_engine, "before_cursor_execute", capture)
        try:
            async with self.sessions() as session:
                await client_access.quota_status(session, self.user.id)
                self.assertEqual(len(statements), 2)
                sql, params = statements[-1]
                plan = (await session.connection()).exec_driver_sql("EXPLAIN QUERY PLAN " + sql, params)
                details = " ".join(str(row) for row in (await plan).all())
                self.assertIn("ix_ai_usage_daily_user_day", details)
                self.assertIn("ix_ai_usage_user_time", details)
        finally:
            event.remove(self.engine.sync_engine, "before_cursor_execute", capture)

    async def test_capacity_queue_rechecks_quota_and_releases_lease_without_upstream_call(self):
        from app.services import model_runtime, model_transport
        from app.services.model_errors import UpstreamError
        await self.policy(10)
        lease = SimpleNamespace(close=AsyncMock())

        async def acquired(_conf):
            self.assertEqual((await self.report(10)).status_code, 200)
            return lease
        with patch.object(model_runtime, "acquire", side_effect=acquired), \
             patch.object(model_runtime, "SessionLocal", self.sessions), \
             patch.object(model_transport, "_client") as upstream:
            with self.assertRaises(UpstreamError) as denied:
                await model_transport.open_response({"quotaUserId": self.user.id}, "/chat/completions", b"{}")
            self.assertEqual(denied.exception.status, 403)
            upstream.assert_not_called()
            lease.close.assert_awaited_once()

    async def test_background_dispatch_cannot_skip_the_billed_users_limit(self):
        from fastapi import HTTPException
        from app.services import task_dispatch, conversation_handoffs
        await self.override("limited", 0)
        async with self.sessions() as session:
            task = models.Task(id="quota-task", title="Quota task", owner_client_id=self.devices[0].id,
                               assignee_user_id=self.user.id, status="todo")
            session.add(task)
            await session.commit()
            with patch.object(conversation_handoffs, "dispatch_body", new=AsyncMock()) as dispatch_body:
                with self.assertRaises(HTTPException) as denied:
                    await task_dispatch.dispatch(tid=task.id, body={}, client=self.devices[0], session=session)
                self.assertEqual(denied.exception.status_code, 403)
                dispatch_body.assert_not_awaited()
                self.assertEqual(task.status, "todo")


if __name__ == "__main__":
    unittest.main()
