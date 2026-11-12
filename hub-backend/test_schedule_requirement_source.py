"""Requirement-derived drafts are independent, authorized and retry safe."""
import asyncio
from datetime import datetime, timezone
import importlib
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""
os.environ.setdefault("AUTH_SECRET", "isolated-requirement-draft-test")
os.environ.setdefault("ADMIN_PASS", "isolated-draft-test-password")

import httpx
from alembic.migration import MigrationContext
from alembic.operations import Operations
from fastapi import FastAPI
from sqlalchemy import create_engine, inspect, select, text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.exc import IntegrityError

from app import models
from app.api import personal_schedules
from app.db import Base, get_session
from app.deps import current_client
from app.services import schedules

for module in (Path(__file__).parent / "app").glob("*models.py"):
    importlib.import_module("app." + module.stem)


class RequirementDraftHttp(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="soduwork-draft-test-")
        self.engine = create_async_engine("sqlite+aiosqlite:///" + str(Path(self.directory.name) / "test.db"))
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        async with self.engine.begin() as connection:
            await connection.run_sync(Base.metadata.create_all)
        async with self.sessions() as session:
            session.add_all([models.User(id="alice", username="alice", is_active=True),
                             models.User(id="bob", username="bob", is_active=True),
                             models.Client(id="device", user_ref="alice", auth_state="active"),
                             models.Client(id="other", user_ref="bob", auth_state="active")])
            await session.commit()
            session.add_all([
                models.Task(id="source", title="Private execution title", note="Private execution note",
                    requirement_content={"title": "Public requirement", "note": "Public instruction"},
                    requirement_version=3, owner_client_id="device", created_by="alice",
                    status="doing", work_routing={"modelName": "local:private:model", "credential": "not-exported"}),
                models.Task(id="foreign", title="Other account", owner_client_id="other", created_by="bob"),
            ])
            await session.commit()
        self.app = FastAPI()
        self.app.include_router(personal_schedules.router, prefix="/api/v1")
        async def db():
            async with self.sessions() as session:
                yield session
        async def device():
            async with self.sessions() as session:
                return await session.get(models.Client, "device")
        self.app.dependency_overrides[get_session] = db
        self.app.dependency_overrides[current_client] = device
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://isolated")
        self.validation = patch.object(schedules, "validate_execution", AsyncMock())
        self.validation.start()
        self.blocker = patch.object(schedules, "capability_save_blocker", return_value=None)
        self.blocker.start()

    async def asyncTearDown(self):
        self.blocker.stop()
        self.validation.stop()
        await self.http.aclose()
        await self.engine.dispose()
        self.directory.cleanup()

    def body(self, **extra):
        return {"title": "Independent draft", "note": "Public instruction", "assigneeId": "local:pi",
                "enabled": True, "sourceRequirement": {"id": "source", "requirementVersion": 3},
                "creationRequestId": "automation-test-123", **extra}

    async def post(self, **extra):
        return await self.http.post("/api/v1/schedules", json=self.body(**extra))

    async def plans(self):
        async with self.sessions() as session:
            return list((await session.scalars(select(models.AiSchedule))).all())

    async def source_row(self):
        async with self.sessions() as session:
            row = await session.get(models.Task, "source")
            return {column.key: getattr(row, column.key) for column in models.Task.__table__.columns}

    async def test_save_forces_disabled_and_preserves_every_source_field(self):
        before = await self.source_row()
        response = await self.post()
        self.assertEqual(response.status_code, 200, response.text)
        self.assertFalse(response.json()["enabled"])
        self.assertEqual(response.json()["sourceRequirement"],
                         {"id": "source", "title": "Public requirement", "requirementVersion": 3})
        self.assertNotIn("Private execution", response.text)
        self.assertNotIn("local:private:model", response.text)
        self.assertNotIn("_requestHash", response.text)
        self.assertEqual(await self.source_row(), before)
        self.assertEqual(len(await self.plans()), 1)

    async def test_open_preflight_and_cancel_create_nothing(self):
        before = await self.source_row()
        with patch.object(schedules, "preflight_execution", AsyncMock(return_value={"state": "ready"})):
            response = await self.http.post("/api/v1/schedules/preflight", json=self.body())
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(await self.plans(), [])
        self.assertEqual(await self.source_row(), before)

    async def test_source_is_not_client_authored_or_mutable_after_creation(self):
        for source in ({"id": "source", "requirementVersion": 3, "title": "Forged"},
                       {"id": "source", "requirementVersion": True}, {"id": "source"}):
            response = await self.post(sourceRequirement=source)
            self.assertEqual(response.status_code, 400, response.text)
        response = await self.post()
        original = response.json()["sourceRequirement"]
        edited = await self.http.put("/api/v1/schedules/" + response.json()["id"], json={
            "enabled": True, "sourceRequirement": {"id": "foreign", "title": "Forged", "requirementVersion": 9}})
        self.assertEqual(edited.status_code, 200, edited.text)
        self.assertTrue(edited.json()["enabled"])
        self.assertEqual(edited.json()["sourceRequirement"], original)

    async def test_stale_archived_missing_and_foreign_sources_do_not_create(self):
        for source, status in (({"id": "source", "requirementVersion": 2}, 409),
                               ({"id": "missing", "requirementVersion": 1}, 404),
                               ({"id": "foreign", "requirementVersion": 1}, 404)):
            response = await self.post(sourceRequirement=source)
            self.assertEqual(response.status_code, status, response.text)
        async with self.sessions() as session:
            row = await session.get(models.Task, "source")
            row.archived_at = datetime.now(timezone.utc)
            await session.commit()
        response = await self.post()
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(await self.plans(), [])

    async def test_shared_read_visibility_does_not_grant_creation(self):
        async with self.sessions() as session:
            row = await session.get(models.Task, "foreign")
            row.shared_org_id = "shared-team"
            await session.commit()
        response = await self.post(sourceRequirement={"id": "foreign", "requirementVersion": 1})
        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual(await self.plans(), [])

    async def test_duplicate_requests_and_lost_response_recover_one_receipt(self):
        first = await self.post()
        second = await self.post()
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.json()["id"], first.json()["id"])
        async with self.sessions() as session:
            row = await session.get(models.Task, "source")
            row.archived_at = datetime.now(timezone.utc)
            row.requirement_version = 4
            await session.commit()
        preflight = await self.http.post("/api/v1/schedules/preflight", json=self.body())
        self.assertEqual(preflight.status_code, 200, preflight.text)
        self.assertEqual(preflight.json()["state"], "ready")
        third = await self.post()
        self.assertEqual(third.json()["id"], first.json()["id"])
        self.assertEqual(len(await self.plans()), 1)

    async def test_same_request_cannot_silently_replace_different_content(self):
        self.assertEqual((await self.post()).status_code, 200)
        response = await self.post(note="Different instruction")
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(len(await self.plans()), 1)

    async def test_concurrent_requests_converge_on_one_persisted_draft(self):
        async def validate(*_args):
            await asyncio.sleep(0.03)
        with patch.object(schedules, "validate_execution", validate):
            responses = await asyncio.gather(self.post(), self.post())
        self.assertEqual([r.status_code for r in responses], [200, 200], [r.text for r in responses])
        self.assertEqual(responses[0].json()["id"], responses[1].json()["id"])
        self.assertEqual(len(await self.plans()), 1)

    async def test_source_edit_waits_until_the_draft_snapshot_is_committed(self):
        validating, release = asyncio.Event(), asyncio.Event()
        async def validate(*_args):
            validating.set()
            await release.wait()
        async def archive():
            async with self.sessions() as session:
                row = await session.get(models.Task, "source")
                row.requirement_version = 4
                row.archived_at = datetime.now(timezone.utc)
                await session.commit()
        with patch.object(schedules, "validate_execution", validate):
            creating = asyncio.create_task(self.post())
            await asyncio.wait_for(validating.wait(), 5)
            editing = asyncio.create_task(archive())
            try:
                await asyncio.sleep(0.05)
                self.assertFalse(editing.done(), "Source edits must not overtake the captured draft snapshot")
            finally:
                release.set()
                response, _ = await asyncio.gather(creating, editing)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["sourceRequirement"]["requirementVersion"], 3)
        self.assertEqual((await self.source_row())["requirement_version"], 4)

    async def test_unrelated_integrity_failure_is_not_mistaken_for_a_duplicate(self):
        async with self.engine.begin() as connection:
            await connection.execute(text("CREATE TRIGGER reject_schedule BEFORE INSERT ON ai_schedule "
                                          "BEGIN SELECT RAISE(ABORT, 'isolated integrity failure'); END"))
        with self.assertRaises(IntegrityError):
            await self.post()
        self.assertEqual(await self.plans(), [])

    async def test_execution_validation_failure_leaves_no_draft_or_source_change(self):
        before = await self.source_row()
        with patch.object(schedules, "validate_execution", AsyncMock(side_effect=ValueError("Fixture unavailable"))):
            response = await self.post()
        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(await self.plans(), [])
        self.assertEqual(await self.source_row(), before)
        self.assertEqual((await self.post()).status_code, 200)

    async def test_account_switch_cannot_replay_or_create_from_previous_source(self):
        saved = (await self.post()).json()
        async with self.sessions() as session:
            row = await session.get(models.Client, "device")
            row.user_ref = "bob"
            await session.commit()
        response = await self.post()
        self.assertEqual(response.status_code, 404, response.text)
        self.assertEqual((await self.http.get("/api/v1/schedules")).json(), [])
        self.assertEqual([row.id for row in await self.plans()], [saved["id"]])

    async def test_ordinary_creation_retains_enabled_behavior_without_provenance(self):
        body = {key: value for key, value in self.body().items() if key not in ("sourceRequirement", "creationRequestId")}
        response = await self.http.post("/api/v1/schedules", json=body)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(response.json()["enabled"])
        self.assertEqual(response.json()["sourceRequirement"], {})

    async def test_missing_retry_identity_is_rejected_before_creation(self):
        for key in (None, "", "a", "../unsafe"):
            response = await self.post(creationRequestId=key)
            self.assertEqual(response.status_code, 400, response.text)
        self.assertEqual(await self.plans(), [])

    async def test_legacy_adoption_adds_provenance_before_stamping_head(self):
        from app import db, schema_migrations
        from app.config import get_settings
        async with self.sessions() as session:
            session.add(models.AiSchedule(id="legacy-plan", title="Keep legacy title", note="Keep legacy instruction",
                owner_client_id="device", created_by="alice", enabled=True, assignee_id="local:pi"))
            await session.commit()
        async with self.engine.begin() as connection:
            await connection.execute(text("ALTER TABLE ai_schedule DROP COLUMN source_requirement"))
        with patch.dict(os.environ, {"DATABASE_URL": str(self.engine.url)}):
            get_settings.cache_clear()
            try:
                expected = schema_migrations._head_revision()
                head = await schema_migrations.migrate_database(
                    self.engine, Base.metadata, db._ensure_columns, db._backfill_data)
                self.assertEqual(head, expected)
                # Reopening an adopted database must not add or overwrite the column again.
                self.assertEqual(await schema_migrations.migrate_database(
                    self.engine, Base.metadata, db._ensure_columns, db._backfill_data), head)
            finally:
                get_settings.cache_clear()
        async with self.engine.connect() as connection:
            row = (await connection.execute(text(
                "SELECT title, note, enabled, source_requirement FROM ai_schedule WHERE id='legacy-plan'"))).one()
            self.assertEqual(row, ("Keep legacy title", "Keep legacy instruction", 1, "{}"))
            columns = await connection.run_sync(lambda conn: inspect(conn).get_columns("ai_schedule"))
            self.assertFalse(next(column for column in columns if column["name"] == "source_requirement")["nullable"])
            self.assertEqual(await connection.scalar(text("SELECT version_num FROM alembic_version")), head)


class RequirementSourceMigration(unittest.TestCase):
    def test_migration_preserves_old_schedules_and_can_downgrade(self):
        migration = importlib.import_module("migrations.versions.0088_schedule_requirement_source")
        engine = create_engine("sqlite://")
        with engine.begin() as connection:
            connection.execute(text("CREATE TABLE ai_schedule (id TEXT PRIMARY KEY, note TEXT)"))
            connection.execute(text("INSERT INTO ai_schedule VALUES ('existing', 'Keep original')"))
            with Operations.context(MigrationContext.configure(connection)):
                migration.upgrade()
            self.assertEqual(connection.execute(text("SELECT note, source_requirement FROM ai_schedule")).one(),
                             ("Keep original", "{}"))
            with Operations.context(MigrationContext.configure(connection)):
                migration.downgrade()
            self.assertEqual([column["name"] for column in inspect(connection).get_columns("ai_schedule")], ["id", "note"])
            self.assertEqual(connection.scalar(text("SELECT note FROM ai_schedule")), "Keep original")
        engine.dispose()


if __name__ == "__main__":
    unittest.main()
