"""Default-open bundled policy through isolated persistence and authenticated APIs."""
import asyncio
import json
import os
from pathlib import Path
import secrets
import shutil
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ["CLUSTER_REDIS_URL"] = ""
os.environ.setdefault("AUTH_SECRET", secrets.token_hex(32))
os.environ.setdefault("ADMIN_PASS", secrets.token_hex(24))

import httpx

from app import models
from app.auth import sign_token
from app.services import mcp_servers, skill_packages, skill_preferences, skills, workflow_inputs
from skill_test_support import fixture


class BundledPolicyDefaults(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="soduwork-builtin-policy-")
        self.root = Path(self.tmp.name)
        self.app, self.tokens, self.sessions, self.cleanup = await fixture(self.root)
        self.bundled = self.root / "bundled"
        self.host = self.root / "host"
        self.bundled.mkdir()
        self.host.mkdir()
        self.names = {"method-a", "method-b", "mcp-tools"}
        for name in self.names:
            self.write_skill(self.bundled, name)
        self.patches = [
            patch.object(skills, "bundled_root", lambda: str(self.bundled)),
            patch.object(skills, "default_roots", lambda: [str(self.bundled), str(self.host)]),
        ]
        for mocked in self.patches:
            mocked.start()
        skills.clear_scan_cache()
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app),
                                     base_url="http://fixture", headers={
                                         "Authorization": "Device " + self.tokens["alice"]})
        self.admin_headers = {"Authorization": "Bearer " + self.tokens["admin"]}

    async def asyncTearDown(self):
        await self.http.aclose()
        for mocked in reversed(self.patches):
            mocked.stop()
        await self.cleanup()
        self.tmp.cleanup()

    @staticmethod
    def write_skill(root, name):
        folder = root / name
        folder.mkdir()
        (folder / "SKILL.md").write_text(
            f"---\nname: {name}\ndescription: A deterministic policy fixture.\n---\n"
            "Use only the explicitly authorized task resources.\n", encoding="utf-8")

    async def store(self, raw):
        async with self.sessions() as session:
            row = await session.get(models.AppSetting, skills.SETTING_KEY)
            if row is None:
                row = models.AppSetting(key=skills.SETTING_KEY, value=raw)
                session.add(row)
            else:
                row.value = raw
            await session.commit()

    async def raw(self):
        async with self.sessions() as session:
            row = await session.get(models.AppSetting, skills.SETTING_KEY)
            return None if row is None else row.value

    async def policy(self):
        async with self.sessions() as session:
            return await skills.load_cfg(session)

    async def bootstrap(self):
        async with self.sessions() as session:
            return await skills.bootstrap(session)

    async def admin_catalog(self):
        response = await self.http.get("/api/v1/admin/capabilities", headers=self.admin_headers)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def save(self, cfg):
        response = await self.http.put("/api/v1/admin/capabilities", json={"cfg": cfg},
                                       headers=self.admin_headers)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()

    async def test_missing_settings_default_open_without_individual_skill_rows(self):
        self.assertEqual(set((await self.policy())["allowed"]), self.names)
        self.assertIsNone(await self.raw(), "Reading the catalog must not write policy")
        await self.bootstrap()
        stored = json.loads(await self.raw())
        self.assertEqual(stored["policyVersion"], 1)
        self.assertEqual(stored["builtinDisabled"], [])
        view = await self.admin_catalog()
        self.assertEqual(view["summary"]["skills"], len(self.names))
        self.assertEqual(view["summary"]["allowed"], len(self.names))
        self.assertTrue(all(item["allowed"] for item in view["skills"]))
        response = await self.http.get("/api/v1/skills")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(set(response.json()["enabled"]), self.names)

    async def test_legacy_upgrade_reopens_old_builtins_and_preserves_external_grants(self):
        self.write_skill(self.host, "external-approved")
        self.write_skill(self.host, "external-blocked")
        legacy = {"allowed": ["method-a", "external-approved"],
                  "roots": [str(self.host)], "byRepo": {"project": ["method-a"]}}
        await self.store(json.dumps(legacy))
        await self.bootstrap()
        cfg = await self.policy()
        self.assertEqual(set(cfg["allowed"]), self.names | {"external-approved"})
        self.assertEqual(cfg["roots"], legacy["roots"])
        self.assertEqual(cfg["byRepo"], legacy["byRepo"])
        first = await self.raw()
        await self.bootstrap()
        self.assertEqual(await self.raw(), first, "Repeated startup must be idempotent")

    async def test_administrator_close_survives_bootstrap_and_all_execution_entry_points(self):
        await self.bootstrap()
        cfg = (await self.admin_catalog())["cfg"]
        cfg["allowed"] = sorted(self.names - {"method-b"})
        await self.save(cfg)
        raw = json.loads(await self.raw())
        self.assertIn("method-b", raw["builtinDisabled"])
        self.assertNotIn("method-b", raw["allowed"])
        await self.bootstrap()
        skills.clear_scan_cache()
        self.assertEqual(set((await self.policy())["allowed"]), self.names - {"method-b"})
        catalog = (await self.http.get("/api/v1/capabilities")).json()
        entry = next(row for row in catalog["skills"] if row["name"] == "method-b")
        self.assertFalse(entry["available"])
        async with self.sessions() as session:
            alice = await session.get(models.Client, "device-alice")
            with self.assertRaisesRegex(ValueError, "method-b"):
                await skills.resolve_named(session, ["method-b"], alice)
            resolved = await skills.resolve_named(session, ["method-a"], alice)
            self.assertEqual([row["name"] for row in resolved], ["method-a"])
            version = SimpleNamespace(capability_report={"externalSkills": ["method-b"]},
                                      package_path="", checksum="")
            with patch.object(workflow_inputs.plugin_packages, "materialize_skills", return_value=[]):
                with self.assertRaisesRegex(ValueError, "method-b"):
                    await workflow_inputs.plugin_skills(session, version)
        for name, expected in [("method-a", 200), ("method-b", 404)]:
            response = await self.http.get(f"/api/v1/skills/{name}/details")
            self.assertEqual(response.status_code, expected, response.text)
            runtime = await self.http.post("/api/v1/skills/runtime", json={"names": [name]})
            self.assertEqual(runtime.status_code, 204 if expected == 200 else 404, runtime.text)

    async def test_default_grants_are_consistent_for_details_runtime_and_plugin_dependencies(self):
        response = await self.http.get("/api/v1/skills/method-b/details")
        self.assertEqual(response.status_code, 200, response.text)
        download = await self.http.get("/api/v1/skills/method-b/download", params={
            "checksum": response.json()["checksum"]})
        self.assertEqual(download.status_code, 200)
        runtime = await self.http.post("/api/v1/skills/runtime", json={"names": ["method-b"]})
        self.assertEqual(runtime.status_code, 204, runtime.text)
        async with self.sessions() as session:
            version = SimpleNamespace(capability_report={"externalSkills": ["method-b"]},
                                      package_path="", checksum="")
            with patch.object(workflow_inputs.plugin_packages, "materialize_skills", return_value=[]):
                rows = await workflow_inputs.plugin_skills(session, version)
            self.assertEqual([row["name"] for row in rows], ["method-b"])
        catalog = (await self.http.get("/api/v1/capabilities")).json()
        self.assertTrue(catalog["summary"]["mcpReady"])

    async def test_builtin_revocation_during_scan_blocks_the_inflight_dispatch(self):
        await self.bootstrap()
        started, release = threading.Event(), threading.Event()
        original = skills.scan
        def delayed(*args, **kwargs):
            started.set()
            if not release.wait(5):
                raise AssertionError("Fixture scan was not released")
            return original(*args, **kwargs)
        skills.clear_scan_cache()
        async with self.sessions() as session:
            with patch.object(skills, "scan", delayed):
                pending = asyncio.create_task(skills.resolve_named(session, ["method-b"]))
                try:
                    self.assertTrue(await asyncio.to_thread(started.wait, 5))
                    cfg = json.loads(await self.raw())
                    cfg["builtinDisabled"] = ["method-b"]
                    await self.store(json.dumps(cfg))
                finally:
                    release.set()
                with self.assertRaisesRegex(ValueError, "method-b"):
                    await pending

    async def test_new_builtin_defaults_open_when_saving_an_older_catalog(self):
        await self.bootstrap()
        old = (await self.admin_catalog())["cfg"]
        self.assertEqual(set(old["builtinCatalog"]), self.names)
        self.write_skill(self.bundled, "method-new")
        skills.clear_scan_cache()
        old["allowed"] = sorted(self.names - {"method-b"})
        await self.save(old)
        self.assertEqual(set((await self.policy())["allowed"]),
                         self.names - {"method-b"} | {"method-new"})
        await self.bootstrap()
        self.assertEqual(set((await self.policy())["allowed"]),
                         self.names - {"method-b"} | {"method-new"})

    async def test_imported_shadow_and_host_skills_do_not_inherit_builtin_defaults(self):
        self.write_skill(self.host, "host-method")
        # The company package predates a later release introducing the same built-in name.
        shutil.rmtree(self.bundled / "method-a")
        for name in ["method-a", "imported-method"]:
            parsed = skill_packages.create(name, "An imported fixture.", "Follow the task scope.")
            row = skill_packages.install(parsed, "company")
            self.assertTrue(row["bundled"], "Imported packages are also bundled, but not built-in")
        self.write_skill(self.bundled, "method-a")
        skills.clear_scan_cache()
        await self.bootstrap()
        self.assertEqual(set((await self.policy())["allowed"]), self.names - {"method-a"})
        async with self.sessions() as session:
            for name in ["method-a", "imported-method", "host-method"]:
                with self.subTest(name=name), self.assertRaisesRegex(ValueError, name):
                    await skills.resolve_named(session, [name])
        view = await self.admin_catalog()
        view["cfg"]["allowed"].append("imported-method")
        await self.save(view["cfg"])
        self.assertIn("imported-method", (await self.policy())["allowed"])

    async def test_complete_project_catalog_is_open_without_an_allowlist_seed(self):
        root = Path(__file__).resolve().parents[1] / "skills"
        expected = {row["name"] for row in skills.scan_root(str(root))}
        self.assertTrue({"code-review", "tdd", "writing-skills", "grilling"} <= expected)
        with patch.object(skills, "bundled_root", return_value=str(root)), \
                patch.object(skills, "default_roots", return_value=[str(root)]):
            skills.clear_scan_cache()
            cfg = await self.policy()
        self.assertEqual(set(cfg["allowed"]), expected)

    async def test_invalid_and_future_policy_never_turn_into_fresh_install_defaults(self):
        for raw in ["{", json.dumps({"allowed": {"method-a": True}}),
                    json.dumps({"policyVersion": 99, "allowed": [], "builtinDisabled": []}),
                    json.dumps({"policyVersion": 1, "allowed": [], "builtinDisabled": "method-a"})]:
            with self.subTest(raw=raw):
                await self.store(raw)
                await self.bootstrap()
                self.assertEqual(await self.raw(), raw)
                self.assertFalse(set((await self.policy())["allowed"]) & self.names)
                response = await self.http.put("/api/v1/admin/capabilities", json={
                    "cfg": {"allowed": sorted(self.names)}}, headers=self.admin_headers)
                self.assertEqual(response.status_code, 409, response.text)
                self.assertEqual(await self.raw(), raw, "An invalid policy cannot be reset by saving")

    async def test_migration_does_not_rewrite_personal_selection(self):
        async with self.sessions() as session:
            alice = await session.get(models.Client, "device-alice")
            alice.skills = ["method-a"]
            bob = await session.get(models.Client, "device-bob")
            bob.skills = []
            bob.config = {skill_preferences.KEY: {"version": 1, "disabled": sorted(self.names)}}
            await session.commit()
        await self.store(json.dumps({"allowed": [], "roots": [], "byRepo": {}}))
        await self.bootstrap()
        self.assertEqual(set((await self.policy())["allowed"]), self.names)
        response = await self.http.get("/api/v1/skills")
        self.assertEqual(set(response.json()["enabled"]), {"method-a"})
        response = await self.http.get("/api/v1/skills", headers={
            "Authorization": "Device " + self.tokens["bob"]})
        self.assertEqual(response.json()["enabled"], [])

    async def test_invalid_policy_edits_cannot_overwrite_valid_choices(self):
        await self.bootstrap()
        cfg = (await self.admin_catalog())["cfg"]
        before = await self.raw()
        invalid = [{"allowed": "method-a"}, {"allowed": [{}]}, {"allowed": [None]},
                   {"roots": "/unexpected/path"}, {"roots": [None]},
                   {"byRepo": []}, {"byRepo": {"project": "method-a"}},
                   {"byRepo": {"project": [None]}}, {"builtinCatalog": "method-a"},
                   {"builtinCatalog": [{}]}]
        bodies = [{"cfg": {**cfg, **change}} for change in invalid]
        bodies += [{"cfg": []}, {"cfg": None}]
        for body in bodies:
            with self.subTest(body=body):
                response = await self.http.put("/api/v1/admin/capabilities", json=body,
                                               headers=self.admin_headers)
                self.assertIn(response.status_code, (400, 409), response.text[:1000])
                self.assertEqual(await self.raw(), before)
        # An intentional empty allowlist is valid and remains distinct from a malformed edit.
        await self.save({**cfg, "allowed": []})
        self.assertEqual((await self.policy())["allowed"], [])

    async def test_mcp_policy_race_returns_conflict_without_committing_selection(self):
        await self.bootstrap()
        before = await self.raw()
        catalog = {"company": [{"name": "company-connector"}], "personal": []}
        cases = [
            ("PATCH", "/api/v1/mcp-servers/selection", {"changes": [
                {"kind": "company", "id": "company-connector", "enabled": True}]}),
            ("PUT", "/api/v1/mcp-servers", {"servers": [],
                                            "enabledCompany": ["company-connector"]}),
            ("POST", "/api/v1/mcp-servers/upsert", {"server": {
                "id": "fixture-connection", "name": "Fixture connection", "type": "http",
                "url": "https://mcp.example.test/mcp", "enabled": True, "approved": True,
                "approvedTarget": "https://mcp.example.test/mcp"}}),
        ]
        for method, path, body in cases:
            with self.subTest(path=path), \
                    patch.object(mcp_servers, "client_view", AsyncMock(return_value=catalog)), \
                    patch.object(skills, "load_cfg", AsyncMock(side_effect=skills.PolicyChanged(
                        "Fixture catalog changed during authorization"))):
                response = await self.http.request(method, path, json=body)
                self.assertEqual(response.status_code, 409, response.text[:1000])
            async with self.sessions() as session:
                alice = await session.get(models.Client, "device-alice")
                self.assertEqual(alice.mcp_enabled, [])
                self.assertEqual(alice.mcp_servers, [])
                self.assertEqual(alice.skills, [])
            self.assertEqual(await self.raw(), before)

    async def test_two_administrators_cannot_restore_each_others_disabled_builtins(self):
        await self.bootstrap()
        async with self.sessions() as session:
            session.add(models.User(id="admin-two", username="admin-two", display_name="Second admin",
                                    is_super=True, org_id="skill-fixture-org"))
            await session.commit()
        other_headers = {"Authorization": "Bearer " + sign_token("admin-two")}
        first = (await self.admin_catalog())["cfg"]
        response = await self.http.get("/api/v1/admin/capabilities", headers=other_headers)
        self.assertEqual(response.status_code, 200, response.text[:1000])
        second = response.json()["cfg"]
        self.assertEqual(first["policyRevision"], second["policyRevision"])
        first["allowed"] = sorted(self.names - {"method-a"})
        await self.save(first)
        after_first = await self.raw()
        second["allowed"] = sorted(self.names - {"method-b"})
        response = await self.http.put("/api/v1/admin/capabilities", json={"cfg": second},
                                       headers=other_headers)
        self.assertEqual(response.status_code, 409, response.text[:1000])
        self.assertEqual(await self.raw(), after_first)
        self.assertEqual(set((await self.policy())["allowed"]), self.names - {"method-a"})


if __name__ == "__main__":
    unittest.main()
