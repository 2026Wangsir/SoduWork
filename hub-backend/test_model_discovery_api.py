"""Admin discovery endpoint: saved-provider-only, read-only, name-filtered."""
import importlib
import os
from pathlib import Path
import unittest
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

import httpx
from fastapi import FastAPI
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import models
from app.api import admin
from app.auth import hash_password, sign_token
from app.db import Base, get_session

for model_file in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + model_file.stem)


class ModelDiscoveryEndpointTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add(models.User(id="admin", username="admin", display_name="Admin",
                                    is_super=True, is_active=True, auth_version=1,
                                    password_hash=hash_password("x" * 16)))
            session.add(models.ModelProvider(id="good", name="Good", kind="openai-compat",
                                             base_url="https://gw.example/v1", api_key="k",
                                             builtin=False, enabled=True))
            session.add(models.ModelProvider(id="dark", name="Dark", kind="openai-compat",
                                             base_url="", api_key="", builtin=False, enabled=True))
            session.add(models.ModelDef(id="good:known-model", provider_id="good",
                                         name="known-model", builtin=False, enabled=True))
            await session.commit()
        self.app = FastAPI()
        self.app.include_router(admin.router)

        async def db():
            async with self.sessions() as session:
                yield session

        self.app.dependency_overrides[get_session] = db
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),
                                      base_url="http://isolated")

    async def asyncTearDown(self):
        await self.http.aclose()
        await self.engine.dispose()

    async def request(self, method, path, **kwargs):
        headers = {"Authorization": "Bearer " + sign_token("admin", 1)}
        return await self.http.request(method, "/api/v1/admin" + path, headers=headers, **kwargs)

    async def test_unknown_provider_is_404(self):
        resp = await self.request("POST", "/model-providers/nope/discover")
        self.assertEqual(resp.status_code, 404, resp.text)

    async def test_incomplete_provider_fails_soft_without_network(self):
        resp = await self.request("POST", "/model-providers/dark/discover")
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertFalse(body["ok"])
        self.assertEqual(body["models"], [])

    async def test_discover_returns_new_names_and_lists_known_ones(self):
        from app.services import model_discovery
        calls = []

        async def fake_discover(base, key, kind="openai-compat"):
            calls.append((base, key, kind))
            return {"ok": True, "models": ["known-model", "fresh-a", "fresh-b"],
                    "path": "/models", "detail": ""}

        original = model_discovery.discover
        model_discovery.discover = fake_discover
        try:
            resp = await self.request("POST", "/model-providers/good/discover")
        finally:
            model_discovery.discover = original
        self.assertEqual(resp.status_code, 200, resp.text)
        body = resp.json()
        self.assertTrue(body["ok"])
        self.assertEqual(body["models"], ["fresh-a", "fresh-b"])
        self.assertEqual(body["known"], ["known-model"])
        self.assertEqual(calls, [("https://gw.example/v1", "k", "openai-compat")])

    async def test_discovery_never_writes_model_rows(self):
        from unittest.mock import AsyncMock, patch

        from app.services import model_discovery
        with patch.object(model_discovery, "discover",
                          AsyncMock(return_value={"ok": True, "models": ["ghost"],
                                                  "path": "/models", "detail": ""})):
            resp = await self.request("POST", "/model-providers/good/discover")
        self.assertEqual(resp.status_code, 200, resp.text)
        catalog = await self.request("GET", "/model-catalog")
        ids = [m["id"] for m in catalog.json()["models"]]
        self.assertNotIn("good:ghost", ids)


if __name__ == "__main__":
    unittest.main()
