"""Bundled plugin upgrades preserve immutable snapshots and explicit review decisions."""
import copy
import hashlib
import json
import os
from pathlib import Path
import tempfile
import unittest

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app import automation_models as am
from app.services import plugin_packages, plugin_service


PLUGINS = Path(__file__).resolve().parent / "plugins"
# Versions in the first public release and the v1.13.15 draft source.
UPGRADES = {
    "project-validation-release": ("1.5.6", "1.5.7"),
    "soduwork-fast-change": ("1.0.2", "1.0.3"),
    "software-delivery": ("1.7.6", "1.7.7"),
}
TABLES = (am.Plugin, am.PluginVersion, am.PluginBinding, am.PluginInstallation)


def bundled(key):
    return json.loads((PLUGINS / f"{key}.json").read_text(encoding="utf-8"))


def checksum(raw):
    return hashlib.sha256(json.dumps(
        raw, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


class BuiltinVersionTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.work = tempfile.TemporaryDirectory(prefix="plugin-version-upgrade-")
        self.addCleanup(self.work.cleanup)
        database = Path(self.work.name) / ".smoke.db"
        self.engine = create_async_engine("sqlite+aiosqlite:///" + database.as_posix())
        self.addAsyncCleanup(self.engine.dispose)
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            for model in TABLES:
                await connection.run_sync(model.__table__.create)

    async def snapshot(self):
        # Read persisted columns rather than cached ORM objects after each startup.
        async with self.engine.connect() as connection:
            return {
                model.__name__: {
                    row["id"]: copy.deepcopy(dict(row))
                    for row in (await connection.execute(
                        select(model.__table__))).mappings()
                }
                for model in TABLES
            }

    async def startup(self):
        # Each startup uses a fresh session against the same on-disk database.
        async with self.sessions() as session:
            await plugin_service.bootstrap_example(session)

    async def seed_existing(self, *, reuse_bundled_version=False):
        self.stored_files = {}
        async with self.sessions() as session:
            for key, (old_version, _new_version) in UPGRADES.items():
                raw = bundled(key)
                if not reuse_bundled_version:
                    raw["version"] = old_version
                # Synthetic historical content reproduces a different checksum
                # under the reported immutable version without private user data.
                raw["description"] = f"Previously reviewed {key} fixture"
                raw["workflow"]["nodes"][0]["config"]["prompt"] = (
                    "Produce the previously reviewed fixture result.")
                manifest, workflow, report = plugin_packages.normalize(raw)
                package_path = Path(self.work.name) / f"{key}.json"
                payload = json.dumps(raw, ensure_ascii=False).encode()
                package_path.write_bytes(payload)
                self.stored_files[package_path] = payload
                plugin = am.Plugin(
                    key=key, name=raw["name"], description=raw["description"],
                    source_kind="builtin", enabled=True, created_by="system")
                session.add(plugin)
                await session.flush()
                version = am.PluginVersion(
                    plugin_id=plugin.id, version=raw["version"], checksum=checksum(raw),
                    manifest=manifest, workflow=workflow, capability_report=report,
                    provenance=plugin_service.provenance_api({
                        "publisherId": "system", "publisherName": "SoduWork 平台",
                        "publisherType": "platform", "channel": "builtin",
                        "sourceName": package_path.name, "sourceKind": "builtin",
                        "signatureState": "platform", "checksum": checksum(raw),
                    }),
                    package_path=str(package_path), trust_state="approved",
                    enabled=True, created_by="system")
                session.add(version)
                await session.flush()
                session.add_all([
                    am.PluginBinding(
                        plugin_id=plugin.id, version_id=version.id,
                        org_id="fixture-org", project_id="fixture-project",
                        config={"releaseChannel": "validation"}, enabled=True),
                    am.PluginInstallation(
                        plugin_id=plugin.id, version_id=version.id,
                        user_id="fixture-user", config={"language": "en"}, enabled=True),
                ])
            await session.commit()
        return await self.snapshot()

    def assert_preserved(self, before, after):
        for model, rows in before.items():
            for identity, row in rows.items():
                self.assertEqual(after[model][identity], row, (model, identity))
        for model in ("PluginBinding", "PluginInstallation"):
            self.assertEqual(after[model], before[model])
        for path, payload in self.stored_files.items():
            self.assertEqual(path.read_bytes(), payload)

    def assert_current_candidates(self, state, *, upgraded):
        for key, (old_version, new_version) in UPGRADES.items():
            with self.subTest(plugin=key):
                plugins = [row for row in state["Plugin"].values() if row["key"] == key]
                self.assertEqual(len(plugins), 1)
                plugin = plugins[0]
                self.assertIs(plugin["enabled"], upgraded)
                versions = [row for row in state["PluginVersion"].values()
                            if row["plugin_id"] == plugin["id"]]
                self.assertCountEqual(
                    [row["version"] for row in versions],
                    [old_version, new_version] if upgraded else [new_version])
                candidate = next(row for row in versions if row["version"] == new_version)
                self.assertEqual(candidate["trust_state"], "quarantined")
                self.assertFalse(candidate["enabled"])
                raw = bundled(key)
                manifest, workflow, report = plugin_packages.normalize(raw)
                self.assertEqual(candidate["checksum"], checksum(raw))
                self.assertEqual(candidate["manifest"], manifest)
                self.assertEqual(candidate["workflow"], workflow)
                self.assertEqual(candidate["capability_report"], report)
                self.assertEqual(candidate["provenance"]["signatureState"], "platform")
                self.assertEqual(candidate["provenance"]["channel"], "builtin")

    async def test_upgrade_preserves_approved_versions_bindings_and_installations(self):
        before = await self.seed_existing()
        with self.assertNoLogs("uvicorn.error", level="ERROR"):
            await self.startup()
        upgraded = await self.snapshot()
        self.assert_preserved(before, upgraded)
        self.assert_current_candidates(upgraded, upgraded=True)
        for _ in range(2):
            with self.assertNoLogs("uvicorn.error", level="ERROR"):
                await self.startup()
            self.assertEqual(await self.snapshot(), upgraded)
            self.assert_preserved(before, await self.snapshot())

    async def test_fresh_start_and_restarts_preserve_explicit_review_decisions(self):
        with self.assertNoLogs("uvicorn.error", level="ERROR"):
            await self.startup()
        initial = await self.snapshot()
        self.assert_current_candidates(initial, upgraded=False)
        with self.assertNoLogs("uvicorn.error", level="ERROR"):
            await self.startup()
        self.assertEqual(await self.snapshot(), initial)

        # Approve one candidate and revoke another through the normal service;
        # leave the third pending to cover all review states on restart.
        async with self.sessions() as session:
            for key, enabled in (("project-validation-release", True),
                                 ("soduwork-fast-change", False)):
                version = await session.scalar(select(am.PluginVersion).join(
                    am.Plugin, am.Plugin.id == am.PluginVersion.plugin_id).where(
                        am.Plugin.key == key))
                await plugin_service.approve_version(
                    session, version, enabled, "fixture-reviewer")
                self.assertEqual(version.trust_state, "approved" if enabled else "revoked")
                self.assertIs(version.enabled, enabled)
        reviewed = await self.snapshot()
        for _ in range(2):
            with self.assertNoLogs("uvicorn.error", level="ERROR"):
                await self.startup()
            self.assertEqual(await self.snapshot(), reviewed)

    async def test_changed_content_cannot_reuse_an_immutable_version(self):
        before = await self.seed_existing(reuse_bundled_version=True)
        registered = None
        for _ in range(2):
            with self.assertLogs("uvicorn.error", level="ERROR") as logs:
                await self.startup()
            self.assertEqual(len(logs.records), len(UPGRADES))
            self.assertEqual(
                {record.args for record in logs.records},
                {(key, bundled(key)["version"]) for key in UPGRADES})
            after = await self.snapshot()
            self.assert_preserved(before, after)
            for plugin in before["Plugin"].values():
                self.assertEqual(sum(row["plugin_id"] == plugin["id"]
                                     for row in after["PluginVersion"].values()), 1)
            # Conflicts do not prevent registration of unrelated bundled plugins.
            self.assertTrue(any(row["key"] == "product-prototype"
                                for row in after["Plugin"].values()))
            if registered is not None:
                self.assertEqual(after, registered)
            registered = after


if __name__ == "__main__":
    unittest.main()
