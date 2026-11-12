"""Competing model editors must never silently overwrite each other."""
import asyncio
import json
from unittest.mock import AsyncMock, patch

from fastapi import HTTPException

from test_model_runtime import IsolatedDatabase
from app.models import Client, ModelDef, ModelProvider
from app.api import admin, config, tasks, model_runtime as runtime_api
from app.services import model_catalog, model_config_guard as guard, model_runtime


class ModelConfigTests(IsolatedDatabase):
    async def test_organization_defaults_reject_stale_editor_and_other_worker_cache(self):
        from app.services import llm
        async with self.sessions() as session:
            original = await admin.get_llm_config(session)
            await admin.put_llm_config({"expectedRevision": original["revision"],
                "baseUrl": "https://fresh.invalid/v1", "model": "fresh", "apiKey": "new-key"}, None, session)
        async with self.sessions() as session:
            with patch.object(llm, "_cache", {"llm_model": "old-worker-value"}):
                self.assertEqual((await llm.load(session))["llm_model"], "fresh")
            with self.assertRaises(HTTPException) as error:
                await admin.put_llm_config({"expectedRevision": original["revision"], "model": "stale"}, None, session)
            self.assertEqual(error.exception.status_code, 409)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        async with self.sessions() as session, session.begin():
            session.add_all([
                Client(id="device", user_ref="user", config={"theme": "light"}),
                ModelProvider(id="provider", name="fixture", api_key="private-key", base_url="https://fixture.invalid/v1"),
                ModelProvider(id="other", name="other", api_key="another-key", base_url="https://other.invalid/v1"),
                ModelDef(id="provider:model", provider_id="provider", name="model"),
            ])
        self.audit = patch.object(admin.audit, "log", new=AsyncMock())
        self.audit.start()
        self.addCleanup(self.audit.stop)

    async def test_personal_stale_snapshot_rejected_with_original_preserved(self):
        async with self.sessions() as left, self.sessions() as right:
            first = await left.get(Client, "device")
            stale = await right.get(Client, "device")
            revision = guard.revision(first)
            await tasks.put_my_models({"expectedRevision": revision, "models": [
                {"providerId": "provider", "name": "fresh"}]}, first, left)
            with self.assertRaises(HTTPException) as error:
                await tasks.put_my_models({"expectedRevision": revision, "models": []}, stale, right)
            self.assertEqual(error.exception.status_code, 409)
            await right.rollback()
        async with self.sessions() as session:
            current = await session.get(Client, "device")
            self.assertEqual(current.models[0]["name"], "fresh")
            self.assertNotEqual(guard.revision(current), revision)

    async def test_missing_revision_cannot_replace_lists_but_key_patches_merge(self):
        async with self.sessions() as session:
            client = await session.get(Client, "device")
            with self.assertRaises(HTTPException) as error:
                await tasks.put_my_models({"models": []}, client, session)
            self.assertEqual(error.exception.status_code, 428)
            await session.rollback()
        # Both callers read an old snapshot before either write begins.
        async with self.sessions() as left, self.sessions() as right:
            first, second = await left.get(Client, "device"), await right.get(Client, "device")
            await asyncio.gather(
                tasks.put_my_models({"keys": {"provider": "left"}}, first, left),
                tasks.put_my_models({"keys": {"other": "right"}}, second, right))
        async with self.sessions() as session:
            client = await session.get(Client, "device")
            self.assertEqual(client.model_keys, {"provider": "left", "other": "right"})
            result = await tasks.my_models(client, session)
            self.assertIn("revision", result)
            self.assertNotIn("private-key", json.dumps(result))
            self.assertNotIn("another-key", json.dumps(result))

    async def test_theme_patch_preserves_new_models_and_does_not_offer_bypass(self):
        async with self.sessions() as left, self.sessions() as right:
            first, stale = await left.get(Client, "device"), await right.get(Client, "device")
            await tasks.put_my_models({"expectedRevision": guard.revision(first), "providers": [
                {"id": "provider", "name": "Managed", "baseUrl": "http://localhost:9999/v1"}]}, first, left)
            saved = await config.put_config({"theme": "dark"}, stale, right)
            self.assertEqual(saved["theme"], "dark")
            self.assertNotIn("modelProviders", saved)
            self.assertEqual(stale.config["modelProviders"][0]["id"], "provider")
            # Old clients echo this server-owned field: ignore it without
            # rejecting their unrelated preferences or overwriting the catalog.
            echoed = await config.put_config({"modelProviders": [], "theme": "light"}, stale, right)
            self.assertEqual(echoed["theme"], "light")
            self.assertNotIn("modelProviders", echoed)
        async with self.sessions() as session:
            current = await session.get(Client, "device")
            self.assertEqual(current.config["modelProviders"][0]["id"], "provider")
            self.assertNotIn("modelProviders", await config.get_config(current))

    async def test_admin_model_edit_and_delete_require_current_revision(self):
        async with self.sessions() as session:
            model = await session.get(ModelDef, "provider:model")
            revision = model_catalog._m_api(model)["revision"]
            await admin.put_model_def({"providerId": "provider", "name": "model", "label": "fresh",
                                       "expectedRevision": revision}, None, session)
        async with self.sessions() as session:
            with self.assertRaises(HTTPException) as error:
                await admin.put_model_def({"providerId": "provider", "name": "model", "label": "old",
                                           "expectedRevision": revision}, None, session)
            self.assertEqual(error.exception.status_code, 409)
            await session.rollback()
            with self.assertRaises(HTTPException) as error:
                await admin.del_model_def("provider:model", revision, None, session)
            self.assertEqual(error.exception.status_code, 409)
            await session.rollback()
            self.assertEqual((await session.get(ModelDef, "provider:model")).label, "fresh")

    async def test_two_admins_create_same_provider_only_one_succeeds(self):
        async def save(name):
            async with self.sessions() as session:
                try:
                    await admin.put_model_provider("new-provider", {"name": name, "expectedRevision": "new"}, None, session)
                    return 200
                except HTTPException as error:
                    return error.status_code
        self.assertEqual(sorted(await asyncio.gather(save("first"), save("second"))), [200, 409])
        async with self.sessions() as session:
            row = await session.get(ModelProvider, "new-provider")
            revision = guard.revision(row)
            await admin.put_model_provider("new-provider", {"apiKey": "changed-secret", "expectedRevision": revision}, None, session)
            self.assertNotEqual(guard.revision(row), revision)
            self.assertNotIn("changed-secret", json.dumps(model_catalog._p_api(row)))

    async def test_policy_validation_and_stale_policy_are_enforced(self):
        with patch.object(runtime_api, "SessionLocal", self.sessions):
            snapshot = await runtime_api.get_runtime()
            policy = {**snapshot["policy"], "globalConcurrent": 5}
            saved = await runtime_api.put_runtime({"policy": policy, "expectedRevision": snapshot["revision"]})
            self.assertNotEqual(saved["revision"], snapshot["revision"])
            with self.assertRaises(HTTPException) as error:
                await runtime_api.put_runtime({"policy": snapshot["policy"], "expectedRevision": snapshot["revision"]})
            self.assertEqual(error.exception.status_code, 409)
            for invalid in (0, model_runtime.MAX_POLICY_CONCURRENCY + 1, "8", True):
                with self.assertRaises(HTTPException) as error:
                    await runtime_api.put_runtime({"policy": {**policy, "globalConcurrent": invalid}, "expectedRevision": saved["revision"]})
                self.assertEqual(error.exception.status_code, 400)
        self.assertEqual((await model_runtime.snapshot())["policy"]["globalConcurrent"], 5)
