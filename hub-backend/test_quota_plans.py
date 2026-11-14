"""Real HTTP/ledger regressions for plans, trials, model caps and permissions."""
import copy
import json
import os
import unittest
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch
from types import SimpleNamespace

os.environ.setdefault("AUTH_SECRET", "isolated-quota-plans-secret")
os.environ.setdefault("ADMIN_PASS", "isolated-quota-plans-admin")
os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import FastAPI
from sqlalchemy import event, func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import ai_proxy, client_auth, quotas, usage
from app.auth import sign_token
from app.db import get_session
from app.services import client_access, client_domain_events, device_auth, model_transport, quota_plans as qp, quota_usage
from tests.sqlite_schema import create_fresh_sqlite_schema


class QuotaPlanTests(unittest.IsolatedAsyncioTestCase):
    async def create_database(self):
        return create_async_engine("sqlite+aiosqlite:///:memory:")

    async def asyncSetUp(self):
        await client_domain_events.stop()
        self.engine = await self.create_database()
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            if self.engine.dialect.name == "sqlite":
                await create_fresh_sqlite_schema(connection, models.Base.metadata)
            else:
                await connection.run_sync(models.Base.metadata.create_all)
        self.owner = models.User(id="owner", username="owner", org_id="one")
        self.admin = models.User(id="admin", username="admin", is_super=True)
        self.device = models.Client(id="plans-device")
        device_auth.activate(self.device, self.owner)
        async with self.sessions() as session:
            session.add_all([models.OrgUnit(id="one", name="One"), models.OrgUnit(id="two", name="Two"),
                             self.owner, self.admin, self.device,
                             models.User(id="other", username="other", org_id="two"),
                             models.Role(id="quota-role", name="Quota role", permissions=["quota.manage"]),
                             models.User(id="scoped", username="scoped", org_id="one", role_id="quota-role"),
                             models.ModelProvider(id="provider", name="Provider"),
                             models.ModelProvider(id="second", name="Second")])
            await session.flush()
            session.add_all([models.ModelDef(id="provider:a", provider_id="provider", name="a", label="A"),
                             models.ModelDef(id="provider:b", provider_id="provider", name="b", label="B"),
                             models.ModelDef(id="second:a", provider_id="second", name="a", label="Other A")])
            await session.commit()
        app = FastAPI()
        for router in (quotas.router, client_auth.router, usage.router, ai_proxy.router):
            app.include_router(router)
        async def isolated():
            async with self.sessions() as session:
                yield session
        app.dependency_overrides[get_session] = isolated
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://plans.test")
        self.headers = {"Authorization": "Bearer " + sign_token("admin")}
        self.device_headers = {"Authorization": "Device " + device_auth.issue_session(self.device)[0]}
        client_access._policy_cache = None

    async def asyncTearDown(self):
        await client_domain_events.stop()
        await self.http.aclose()
        await self.engine.dispose()
        client_access._policy_cache = None

    async def configure(self, cap=1000, models_=None, restricted=False):
        body = copy.deepcopy(qp.DEFAULT_CATALOG)
        body["plans"][1].update(totalLimit=cap, models=models_ or [], restrictModels=restricted)
        response = await self.http.put("/api/v1/admin/quotas", headers=self.headers, json=body)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def assign(self, body=None, uid="owner"):
        response = await self.http.put("/api/v1/admin/quotas/members/" + uid, headers=self.headers,
            json=body or {"revision": 0, "mode": "plan", "planId": "standard"})
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def receipt(self, count, model="a", provider="provider", key="turn"):
        return await self.http.post("/api/v1/usage/events", headers=self.device_headers,
            json={"sourceId": key, "provider": provider, "model": model, "usage": {"input": count}})

    async def status(self, **kwargs):
        async with self.sessions() as session:
            return await client_access.quota_status(session, "owner", **kwargs)

    async def test_existing_accounts_keep_limits_until_assigned(self):
        async with self.sessions() as session:
            await client_access.save_user_quota(session, "owner", {"mode": "limited", "limit": 99999})
            await session.commit()
        await self.configure(500)
        self.assertEqual((await self.status())["limit"], 99999)
        await self.assign()
        self.assertEqual((await self.status())["limit"], 500)
        await self.assign({"revision": 1, "mode": "inherit"})
        self.assertEqual((await self.status())["limit"], 99999)

    async def test_default_trial_is_once_and_does_not_reset_on_login_or_month(self):
        start = datetime(2026, 1, 30, 12, tzinfo=timezone.utc)
        async with self.sessions() as session:
            await qp.register_trial(session, "owner", now=start)
            await session.commit()
            await qp.register_trial(session, "owner", now=start + timedelta(days=3))
            await session.commit()
            grant = qp.parse(await session.scalar(select(models.AppSetting.value).where(
                models.AppSetting.key == qp.GRANT_PREFIX + "owner")))
        self.assertEqual(grant["trial"]["policy"]["totalLimit"], 100000)
        self.assertEqual(grant["trial"]["expiresAt"], (start + timedelta(days=7)).isoformat())
        active = qp.status_from(grant["trial"]["policy"], grant, {("provider", "a"): 100000},
                                now=start + timedelta(days=3))
        self.assertEqual(active["reason"], "total_exhausted")
        self.assertEqual(active["period"], "trial")
        self.assertIsNone(active["resetsAt"])
        expired = qp.status_from(grant["trial"]["policy"], grant, {}, now=start + timedelta(days=7))
        self.assertEqual(expired["reason"], "trial_expired")

    async def test_trial_edit_affects_only_future_registrations_and_assignment_preserves_expiry(self):
        async with self.sessions() as session:
            await qp.register_trial(session, "owner")
            await session.commit()
        body = copy.deepcopy(qp.DEFAULT_CATALOG)
        body["plans"][0].update(totalLimit=200000, durationDays=14)
        saved = await self.http.put("/api/v1/admin/quotas", headers=self.headers, json=body)
        self.assertEqual(saved.status_code, 200, saved.text)
        original = await self.status()
        self.assertEqual(original["limit"], 100000)
        await self.assign({"revision": 1, "mode": "plan", "planId": "standard"})
        await self.assign({"revision": 2, "mode": "plan", "planId": "trial"})
        self.assertEqual((await self.status())["expiresAt"], original["expiresAt"])
        async with self.sessions() as session:
            await qp.register_trial(session, "other")
            await session.commit()
            status = await client_access.quota_status(session, "other")
            self.assertEqual(status["limit"], 200000)

    async def test_model_caps_and_shared_total_both_apply_without_duplicate_receipts(self):
        await self.configure(100, [{"provider": "provider", "model": "a", "limit": 40},
                                  {"provider": "provider", "model": "b", "limit": 80}])
        await self.assign()
        for _ in range(2):
            response = await self.receipt(40)
            self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual((await self.status())["used"], 40)
        self.assertEqual((await self.status(provider="provider", model="a"))["reason"], "model_exhausted")
        self.assertFalse((await self.status(provider="provider", model="b"))["exceeded"])
        self.assertFalse((await self.status(provider="second", model="a"))["exceeded"])
        await self.receipt(60, model="b", key="second-turn")
        self.assertEqual((await self.status(provider="provider", model="b"))["reason"], "total_exhausted")

    async def test_restricted_models_fail_closed_and_unrestricted_models_share_total(self):
        await self.configure(100, [{"provider": "provider", "model": "a", "limit": 10}], True)
        await self.assign()
        self.assertEqual((await self.status(provider="provider", model="b"))["reason"], "model_not_allowed")
        await self.receipt(10)
        self.assertTrue((await self.status())["exceeded"])

    async def test_legacy_gateway_provider_counts_without_rewriting_frozen_attribution(self):
        await self.configure(1000, [{"provider": "provider", "model": "a", "limit": 40},
                                   {"provider": "provider", "model": "b", "limit": 100},
                                   {"provider": "second", "model": "a", "limit": 100}])
        await self.assign()
        self.assertEqual((await self.receipt(40, provider="soduwork")).status_code, 200)
        state = await self.status(provider="provider", model="a")
        self.assertEqual(state["reason"], "model_exhausted")
        self.assertEqual(state["used"], 40)
        self.assertEqual(state["model"]["unattributedUsed"], 40)
        self.assertFalse((await self.status(provider="provider", model="b"))["exceeded"])
        other = await self.status(provider="second", model="a")
        self.assertEqual(other["model"]["used"], 40)
        async with self.sessions() as session:
            self.assertEqual(await session.scalar(select(models.AIUsageDaily.provider)), "soduwork")

    async def test_expired_and_exhausted_keep_identity_and_receipts(self):
        async with self.sessions() as session:
            await qp.register_trial(session, "owner", now=datetime.now(timezone.utc) - timedelta(days=8))
            await session.commit()
        with patch.object(usage.device_connections, "disconnect", new=AsyncMock()) as disconnect:
            self.assertEqual((await self.receipt(1)).status_code, 200)
            disconnect.assert_not_awaited()
        me = await self.http.get("/api/v1/client-auth/me", headers=self.device_headers)
        self.assertEqual(me.status_code, 200)
        self.assertEqual(me.json()["quota"]["reason"], "trial_expired")
        admission = await self.http.get("/api/v1/client-auth/authorize-ai", headers=self.device_headers)
        self.assertEqual(admission.status_code, 403)
        self.assertEqual(admission.json()["detail"]["code"], "TOKEN_QUOTA_EXCEEDED")

    async def test_custom_zero_and_unlimited_are_distinct(self):
        await self.assign({"revision": 0, "mode": "custom", "custom": {"totalLimit": 0}})
        self.assertTrue((await self.status())["exceeded"])
        await self.assign({"revision": 1, "mode": "custom", "custom": {"totalLimit": None}})
        self.assertFalse((await self.status())["enabled"])
        self.assertIsNone((await self.status())["remaining"])

    async def test_trial_reallocation_notifies_only_its_active_account_after_commit(self):
        body = copy.deepcopy(qp.DEFAULT_CATALOG)
        body["plans"][0]["totalLimit"] = 10
        response = await self.http.put("/api/v1/admin/quotas", headers=self.headers, json=body)
        self.assertEqual(response.status_code, 200)
        async with self.sessions() as session:
            await qp.register_trial(session, "owner")
            session.add_all([
                models.Client(id="owner-second", user_ref="owner", auth_state="active"),
                models.Client(id="owner-revoked", user_ref="owner", auth_state="revoked"),
                models.Client(id="other-device", user_ref="other", auth_state="active"),
            ])
            await session.commit()
        self.assertEqual((await self.receipt(12855)).status_code, 200)
        self.assertEqual((await self.http.get("/api/v1/client-auth/authorize-ai",
                                            headers=self.device_headers)).status_code, 403)
        queued = client_domain_events.account_changed
        async def after_commit(session, owner, topic):
            self.assertFalse(session.in_transaction())
            async with self.sessions() as reader:
                self.assertEqual((await client_access.quota_status(reader, owner))["limit"], 1000000000)
            await queued(session, owner, topic)
        with patch.object(client_domain_events, "account_changed", side_effect=after_commit), \
                patch.object(client_domain_events.native_discovery, "wake", new_callable=AsyncMock) as wake:
            await self.assign({"revision": 1, "mode": "custom", "custom": {"totalLimit": 1000000000}})
            wake.assert_not_awaited()
            await client_domain_events.flush_for_test(self.sessions)
            self.assertEqual({call.args for call in wake.await_args_list}, {
                ("plans-device", "owner", "quota"), ("owner-second", "owner", "quota")})
        restored = await self.http.get("/api/v1/client-auth/authorize-ai", headers=self.device_headers)
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertEqual(restored.json()["quota"]["used"], 12855)
        self.assertEqual(restored.json()["quota"]["planId"], "custom")

    async def test_quota_hint_failure_preserves_committed_assignment_response(self):
        with patch.object(client_domain_events, "account_changed", new_callable=AsyncMock,
                          side_effect=OSError("isolated notification failure")):
            result = await self.assign()
        self.assertEqual(result, {"ok": True, "revision": 1})
        self.assertEqual((await self.status())["planId"], "standard")

    async def test_failed_commit_or_conflict_never_queues_quota_hint(self):
        with patch.object(client_domain_events, "quota_changed", new_callable=AsyncMock) as notify:
            async with self.sessions() as session:
                with patch.object(session, "commit", new_callable=AsyncMock, side_effect=RuntimeError("commit failed")):
                    with self.assertRaisesRegex(RuntimeError, "commit failed"):
                        await quotas.assign("owner", quotas.Assignment(revision=0, mode="plan", planId="standard"),
                                            self.admin, session)
                await session.rollback()
            conflict = await self.http.put("/api/v1/admin/quotas/members/owner", headers=self.headers,
                json={"revision": 1, "mode": "plan", "planId": "standard"})
            self.assertEqual(conflict.status_code, 409)
            scoped = {"Authorization": "Bearer " + sign_token("scoped")}
            denied = await self.http.put("/api/v1/admin/quotas/members/other", headers=scoped,
                json={"revision": 0, "mode": "plan", "planId": "standard"})
            self.assertEqual(denied.status_code, 403)
            notify.assert_not_awaited()

    async def test_catalog_hints_follow_changed_plans_and_inherited_default_only(self):
        assignments = {
            "owner": {"mode": "plan", "planId": "standard"},
            "other": {"mode": "plan", "planId": "pro"},
            "trial": {"mode": "plan", "planId": "trial"},
            "custom": {"mode": "custom", "custom": {"totalLimit": 500}},
            "inherited": {"mode": "inherit"},
        }
        async with self.sessions() as session:
            for uid in ("trial", "custom", "inherited", "default", "limited", "unlimited"):
                session.add(models.User(id=uid, username=uid, org_id="one"))
            await session.flush()
            for uid in ("other", "trial", "custom", "inherited", "default", "limited", "unlimited"):
                session.add(models.Client(id=uid + "-device", user_ref=uid, auth_state="active"))
            for uid, grant in assignments.items():
                session.add(models.AppSetting(key=qp.GRANT_PREFIX + uid, value=json.dumps(grant)))
            for uid, mode in (("limited", "limited"), ("unlimited", "unlimited")):
                await client_access.save_user_quota(session, uid, {"mode": mode, "limit": 100})
            await session.commit()
        body = copy.deepcopy(qp.DEFAULT_CATALOG)
        body["plans"][0]["totalLimit"] += 10
        body["plans"][1]["totalLimit"] += 10
        body["defaultLimit"] = 500
        with patch.object(client_domain_events.native_discovery, "wake", new_callable=AsyncMock) as wake:
            saved = await self.http.put("/api/v1/admin/quotas", headers=self.headers, json=body)
            self.assertEqual(saved.status_code, 200, saved.text)
            wake.assert_not_awaited()
            await client_domain_events.flush_for_test(self.sessions)
            self.assertEqual({call.args for call in wake.await_args_list}, {
                ("plans-device", "owner", "quota"), ("inherited-device", "inherited", "quota"),
                ("default-device", "default", "quota")})
            wake.reset_mock()
            body = saved.json()
            body["plans"][0]["totalLimit"] += 10
            unchanged = await self.http.put("/api/v1/admin/quotas", headers=self.headers, json=body)
            self.assertEqual(unchanged.status_code, 200, unchanged.text)
            await client_domain_events.flush_for_test(self.sessions)
            wake.assert_not_awaited()

    async def test_conflicts_invalid_values_and_deletion_are_rejected(self):
        saved = await self.configure()
        stale = await self.http.put("/api/v1/admin/quotas", headers=self.headers, json=qp.DEFAULT_CATALOG)
        self.assertEqual(stale.status_code, 409)
        for invalid in (-1, 1.5, True, qp.MAX_TOKENS + 1):
            body = {**saved, "plans": copy.deepcopy(saved["plans"])}
            body["plans"][1]["totalLimit"] = invalid
            response = await self.http.put("/api/v1/admin/quotas", headers=self.headers, json=body)
            self.assertEqual(response.status_code, 422, response.text)
        body = {**saved, "plans": saved["plans"][:-1]}
        self.assertEqual((await self.http.put("/api/v1/admin/quotas", headers=self.headers, json=body)).status_code, 422)
        await self.assign()
        conflict = await self.http.put("/api/v1/admin/quotas/members/owner", headers=self.headers,
                                      json={"revision": 0, "mode": "custom", "custom": {"totalLimit": 1}})
        self.assertEqual(conflict.status_code, 409)

    async def test_scoped_management_no_cross_department_access_and_audit_is_written(self):
        employee = {"Authorization": "Bearer " + sign_token("owner")}
        self.assertEqual((await self.http.get("/api/v1/admin/quotas", headers=employee)).status_code, 403)
        scoped = {"Authorization": "Bearer " + sign_token("scoped")}
        listed = await self.http.get("/api/v1/admin/quotas/members", headers=scoped)
        self.assertEqual(listed.status_code, 200, listed.text)
        self.assertNotIn("other", {u["id"] for u in listed.json()["items"]})
        detail = await self.http.get("/api/v1/admin/quotas/members/owner", headers=scoped)
        self.assertEqual(detail.status_code, 200, detail.text)
        self.assertEqual(detail.json(), next(u for u in listed.json()["items"] if u["id"] == "owner"))
        for uid, expected in (("other", 403), ("missing", 404)):
            self.assertEqual((await self.http.get("/api/v1/admin/quotas/members/" + uid,
                headers=scoped)).status_code, expected)
        self.assertEqual((await self.http.get("/api/v1/admin/quotas/members/owner",
            headers=employee)).status_code, 403)
        denied = await self.http.put("/api/v1/admin/quotas/members/other", headers=scoped,
                                     json={"revision": 0, "mode": "custom", "custom": {"totalLimit": 1}})
        self.assertEqual(denied.status_code, 403)
        await self.assign({"revision": 0, "mode": "custom", "custom": {"totalLimit": 1}})
        async with self.sessions() as session:
            audit = await session.scalar(select(models.AuditLog).where(models.AuditLog.action == "quota.member.assign"))
            self.assertEqual(audit.detail["after"]["custom"]["totalLimit"], 1)

    async def test_pagination_uses_bounded_group_queries_not_per_member(self):
        async with self.sessions() as session:
            for i in range(55):
                uid = "member-" + str(i)
                session.add(models.User(id=uid, username=uid, org_id="one"))
                session.add(models.AppSetting(key=qp.GRANT_PREFIX + uid, value=json.dumps({
                    "mode": "plan", "planId": "standard", "revision": 1})))
            await session.commit()
        queries = []
        def observe(conn, cursor, statement, params, context, many):
            queries.append(statement)
        event.listen(self.engine.sync_engine, "before_cursor_execute", observe)
        try:
            response = await self.http.get("/api/v1/admin/quotas/members?limit=50", headers=self.headers)
        finally:
            event.remove(self.engine.sync_engine, "before_cursor_execute", observe)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()["items"]), 50)
        self.assertLessEqual(len(queries), 7)

    async def test_legacy_daily_rows_are_not_double_counted_and_month_boundary_is_beijing(self):
        now = datetime(2026, 3, 1, tzinfo=timezone.utc)
        async with self.sessions() as session:
            session.add_all([
                models.AIUsageEvent(id="frozen", idempotency_key="frozen", billing_user_id="owner", provider="provider", model="a", total_tokens=90, occurred_at=now),
                models.AIUsageEvent(id="legacy", idempotency_key="legacy", billing_user_id="owner", provider="provider", model="a", total_tokens=7, occurred_at=now),
            ])
            await session.flush()
            session.add_all([
                models.AIUsageDaily(usage_event_id="frozen", day_key="2026-02-28", dimension_key="old", billing_user_id="owner", provider="provider", model="a", total_tokens=70, occurred_at=now),
                models.AIUsageDaily(usage_event_id="frozen", day_key="2026-03-01", dimension_key="new", billing_user_id="owner", provider="provider", model="b", total_tokens=20, occurred_at=now),
            ])
            await session.commit()
            monthly = (await quota_usage.totals(session, ["owner"], now=now))["owner"]
            lifetime = (await quota_usage.totals(session, ["owner"], monthly=False))["owner"]
        self.assertEqual(monthly, {("provider", "a"): 7, ("provider", "b"): 20})
        self.assertEqual(sum(lifetime.values()), 97)
        start, _ = quota_usage.month_window(datetime(2026, 2, 28, 17, tzinfo=timezone.utc))
        self.assertEqual(start.day, 1)
        self.assertEqual(start.month, 3)

    async def test_proxy_quota_error_survives_json_and_stream_envelopes(self):
        error = model_transport.UpstreamError(403, "", "Allowance exhausted")
        error.quota_detail = {"code": "TOKEN_QUOTA_EXCEEDED", "message": "Allowance exhausted",
                              "quota": {"exceeded": True, "reason": "model_exhausted"}}
        response = ai_proxy._proxy_error(error)
        payload = json.loads(response.body)
        self.assertEqual(payload["error"]["code"], "TOKEN_QUOTA_EXCEEDED")
        self.assertEqual(payload["detail"]["quota"]["reason"], "model_exhausted")
        self.assertIn(b'TOKEN_QUOTA_EXCEEDED', ai_proxy._in_stream_error_frame(error))

    async def test_transport_checks_resolved_model_after_queue_and_releases_capacity(self):
        from app.services import model_runtime
        await self.configure(100, [{"provider": "provider", "model": "a", "limit": 10}])
        await self.assign()
        lease = SimpleNamespace(close=AsyncMock())
        async def acquired(_conf):
            self.assertEqual((await self.receipt(10)).status_code, 200)
            return lease
        with patch.object(model_runtime, "acquire", side_effect=acquired), \
             patch.object(model_runtime, "SessionLocal", self.sessions), \
             patch.object(model_transport, "_client") as upstream:
            with self.assertRaises(model_transport.UpstreamError) as denied:
                await model_transport.open_response({"quotaUserId": "owner", "provider": "provider", "model": "a"},
                                                     "/chat/completions", b"{}")
        self.assertEqual(denied.exception.quota_detail["quota"]["reason"], "model_exhausted")
        upstream.assert_not_called()
        lease.close.assert_awaited_once()

    async def test_committed_plan_change_is_visible_to_existing_reader_without_cache(self):
        saved = await self.configure(100)
        await self.assign()
        await self.receipt(50)
        async with self.sessions() as reader:
            self.assertFalse((await client_access.quota_status(reader, "owner"))["exceeded"])
            saved["plans"][1]["totalLimit"] = 40
            updated = await self.http.put("/api/v1/admin/quotas", headers=self.headers, json=saved)
            self.assertEqual(updated.status_code, 200, updated.text)
            self.assertTrue((await client_access.quota_status(reader, "owner"))["exceeded"])

    async def test_trial_cannot_be_granted_to_existing_accounts_or_repeated_by_assignment(self):
        response = await self.http.put("/api/v1/admin/quotas/members/owner", headers=self.headers,
            json={"revision": 0, "mode": "plan", "planId": "trial"})
        self.assertEqual(response.status_code, 422)
        async with self.sessions() as session:
            self.assertIsNone(await session.scalar(select(models.AppSetting.value).where(
                models.AppSetting.key == qp.GRANT_PREFIX + "owner")))


if __name__ == "__main__":
    unittest.main()
