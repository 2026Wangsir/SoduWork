"""Rollout request-body type guards: malformed containers must be 400, not a server error."""
import os
import unittest

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am
from app.api import plugins
from app.db import Base, get_session
from app.deps import current_client, current_user
from app.models import AppSetting, AuditLog, Client, OrgUnit, User


class RolloutBodyTypeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(lambda connection: Base.metadata.create_all(connection, tables=[
                am.Plugin.__table__, am.PluginVersion.__table__, am.PluginBinding.__table__,
                User.__table__, OrgUnit.__table__, AppSetting.__table__,
                AuditLog.__table__, Client.__table__]))
        async with self.sessions() as session:
            session.add_all([
                OrgUnit(id="org-1", name="部门甲"),
                User(id="admin-1", username="admin", is_super=True, role_id="", is_active=True),
                am.Plugin(id="p1", org_id=None, key="key-p1", name="切换测试",
                          description="d", enabled=True),
                am.PluginVersion(id="v-old", plugin_id="p1", version="1.0.0", enabled=True,
                                 trust_state="approved", checksum="c-old"),
                am.PluginVersion(id="v-new", plugin_id="p1", version="2.0.0", enabled=True,
                                 trust_state="approved", checksum="c-new"),
                am.PluginBinding(id="b1", plugin_id="p1", version_id="v-old",
                                 org_id="org-1", project_id="", config={}, secret_refs={},
                                 enabled=True),
            ])
            await session.commit()
        self.app = FastAPI()
        self.app.include_router(plugins.router)

        async def session_override():
            async with self.sessions() as session:
                yield session

        async def admin_override():
            async with self.sessions() as session:
                user = await session.get(User, "admin-1")
                user._perms = {"plugin.manage"}
                return user

        async def client_override():
            return Client(id="desk-1", user_ref="admin-1")

        self.app.dependency_overrides[get_session] = session_override
        self.app.dependency_overrides[current_user] = admin_override
        self.app.dependency_overrides[current_client] = client_override
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),
                                        base_url="http://test")

    async def asyncTearDown(self):
        await self.client.aclose()
        await self.engine.dispose()

    async def post_rollout(self, payload):
        return await self.client.post("/api/v1/admin/plugins/p1/rollout", json=payload)

    async def test_binding_ids_must_be_a_list(self):
        for bad in ("b1", "xyz", 123, True, {"b1": "v-old"}):
            response = await self.post_rollout({
                "targetVersionId": "v-new", "bindingIds": bad,
                "expectedVersions": {"b1": "v-old"}})
            self.assertEqual(response.status_code, 400, f"{bad!r} -> {response.status_code}")
            self.assertIn("bindingIds", response.text)

    async def test_expected_versions_must_be_an_object(self):
        for bad in ("b1=v-old", "abc", 123, True, [["b1", "v-old"]]):
            response = await self.post_rollout({
                "targetVersionId": "v-new", "bindingIds": ["b1"],
                "expectedVersions": bad})
            self.assertEqual(response.status_code, 400, f"{bad!r} -> {response.status_code}")
            self.assertIn("expectedVersions", response.text)

    async def test_guards_run_before_state_checks(self):
        # An already-invalid target must still surface the 400 type error, not a 409.
        response = await self.post_rollout({
            "targetVersionId": "v-old", "bindingIds": "b1", "expectedVersions": {}})
        self.assertEqual(response.status_code, 400, response.text)

    async def test_well_formed_rollout_still_succeeds(self):
        response = await self.post_rollout({
            "targetVersionId": "v-new", "bindingIds": ["b1"],
            "expectedVersions": {"b1": "v-old"}})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["ok"])
        async with self.sessions() as session:
            binding = await session.get(am.PluginBinding, "b1")
            self.assertEqual(binding.version_id, "v-new")


if __name__ == "__main__":
    unittest.main()
