"""Restore proven legacy authorship without assigning review to an executor."""
import copy
import importlib
import unittest
from datetime import datetime, timezone

import sqlalchemy as sa
from sqlalchemy.orm import Session

import test_local_requirement_delivery as delivery
import test_unified_requirements_migration as legacy
from app import automation_models as am, models

migration = importlib.import_module("migrations.versions.0090_requirement_creator")


class RequirementCreatorMigrationTests(unittest.TestCase):
    setUp = legacy.RequirementMigrationTests.setUp
    tearDown = legacy.RequirementMigrationTests.tearDown
    old_row = legacy.RequirementMigrationTests.old_row
    migrate = legacy.RequirementMigrationTests.migrate

    def test_0053_linked_delivery_recovers_only_proven_creator_and_is_idempotent(self):
        with Session(self.engine) as session:
            session.add(models.User(id="creator", username="creator", display_name="Current creator", is_active=True))
            session.commit()
        self.old_row("one", delivery_task_id="delivery", status="delivering")
        self.old_row("two", delivery_task_id="delivery", status="delivering", created_by_name="Former name")
        self.migrate()
        with self.engine.begin() as connection:
            task = sa.Table("task", sa.MetaData(), autoload_with=connection)
            before = dict(connection.execute(sa.select(task).where(task.c.id == "delivery")).mappings().one())
            self.assertIsNone(before["created_by"], "0053 reproduces the linked-delivery authorship gap")
            self.assertEqual(migration.migrate_data(connection), 1)
            self.assertEqual(migration.migrate_data(connection), 0)
            after = dict(connection.execute(sa.select(task).where(task.c.id == "delivery")).mappings().one())
            self.assertEqual(after, {**before, "created_by": "creator", "created_by_name": "Current creator"})

    def test_missing_conflicting_cross_scope_and_inactive_evidence_never_infers_a_creator(self):
        cases = ["empty", "malformed", "missing_id", "duplicate_id", "missing_creator", "different_creator",
                 "wrong_delivery", "wrong_org", "missing_acl", "conflicting_acl", "orphan_acl", "device_acl_only",
                 "unknown_user", "inactive_user", "deleted_user", "existing_creator"]
        with Session(self.engine) as session:
            session.add_all([models.User(id="creator", username="creator", is_active=True),
                             models.User(id="other", username="other", is_active=True),
                             models.User(id="inactive_user", username="inactive", is_active=False),
                             models.User(id="deleted_user", username="deleted", is_active=True,
                                         account_deleted_at=datetime.now(timezone.utc))])
            for name in cases:
                session.add(models.Task(id=name, title=name, owner_client_id="owner"))
            session.commit()
        for name in cases:
            uid = name if name in {"unknown_user", "inactive_user", "deleted_user"} else "creator"
            self.old_row(name + "-source", delivery_task_id=name, created_by_user_id=uid)
        self.migrate()
        with Session(self.engine) as session:
            for name in cases:
                task = session.get(models.Task, name)
                sources = copy.deepcopy(task.legacy_requirements)
                if name == "empty":
                    sources = []
                elif name == "malformed":
                    sources.append("not a source snapshot")
                elif name == "missing_id":
                    sources[0].pop("id")
                elif name == "duplicate_id":
                    sources.append(copy.deepcopy(sources[0]))
                elif name == "missing_creator":
                    sources[0]["created_by_user_id"] = None
                elif name == "different_creator":
                    sources.append({**sources[0], "id": "another-source", "created_by_user_id": "other"})
                elif name == "wrong_delivery":
                    sources[0]["delivery_task_id"] = "different-task"
                elif name == "wrong_org":
                    sources[0]["org_id"] = "different-org"
                elif name in {"missing_acl", "device_acl_only"}:
                    query = sa.delete(models.TaskRequirementAccess).where(models.TaskRequirementAccess.task_id == name)
                    if name == "device_acl_only":
                        query = query.where(models.TaskRequirementAccess.principal_kind == "user")
                    session.execute(query)
                elif name == "conflicting_acl":
                    session.add(models.TaskRequirementAccess(task_id=name, source_id=sources[0]["id"],
                        principal_kind="user", principal_id="other", role="creator"))
                elif name == "orphan_acl":
                    session.add(models.TaskRequirementAccess(task_id=name, source_id="missing-snapshot",
                        principal_kind="user", principal_id="creator", role="creator"))
                elif name == "existing_creator":
                    task.created_by, task.created_by_name = "other", "Existing author"
                task.legacy_requirements = sources
            session.commit()
        with self.engine.begin() as connection:
            self.assertEqual(migration.migrate_data(connection), 0)
        with Session(self.engine) as session:
            for name in cases:
                task = session.get(models.Task, name)
                self.assertEqual(task.created_by, "other" if name == "existing_creator" else None, name)
                if name == "existing_creator":
                    self.assertEqual(task.created_by_name, "Existing author")

    def test_every_source_requires_its_own_matching_human_creator_grant(self):
        with Session(self.engine) as session:
            session.add(models.User(id="creator", username="creator", is_active=True))
            session.commit()
        self.old_row("one", delivery_task_id="delivery")
        self.old_row("two", delivery_task_id="delivery")
        self.migrate()
        with Session(self.engine) as session:
            session.execute(sa.delete(models.TaskRequirementAccess).where(
                models.TaskRequirementAccess.source_id == "two", models.TaskRequirementAccess.principal_kind == "user"))
            session.commit()
        with self.engine.begin() as connection:
            self.assertEqual(migration.migrate_data(connection), 0)


class RecoveredCreatorDeliveryTests(unittest.IsolatedAsyncioTestCase):
    asyncSetUp = delivery.LocalRequirementDeliveryTests.asyncSetUp
    asyncTearDown = delivery.LocalRequirementDeliveryTests.asyncTearDown
    call = delivery.LocalRequirementDeliveryTests.call
    create_running = delivery.LocalRequirementDeliveryTests.create_running
    deliver = delivery.LocalRequirementDeliveryTests.deliver
    assert_pending_creator_review = delivery.LocalRequirementDeliveryTests.assert_pending_creator_review

    async def test_http_submission_recovers_after_migration_but_never_approves_automatically(self):
        tid = await self.create_running("manual")
        async with self.sessions() as session:
            task = await session.get(models.Task, tid)
            task.created_by = None
            task.legacy_requirements = [{"id": "legacy-requirement", "created_by_user_id": "owner",
                "delivery_task_id": tid, "org_id": task.shared_org_id}]
            session.add(models.TaskRequirementAccess(task_id=tid, source_id="legacy-requirement",
                principal_kind="user", principal_id="owner", role="creator"))
            await session.commit()
        self.assertEqual((await self.deliver(tid)).status_code, 200)
        denied = await self.call("POST", "tasks/" + tid + "/submit-review", json={})
        self.assertEqual(denied.status_code, 409, denied.text)
        self.assertIn("当前只能分配给 0 人", denied.text)
        async with self.engine.begin() as connection:
            self.assertEqual(await connection.run_sync(migration.migrate_data), 1)
        async with self.sessions() as session:
            self.assertIsNone(await session.scalar(sa.select(am.ApprovalRequest.id).where(am.ApprovalRequest.task_id == tid)))
            self.assertIsNone((await session.get(models.Task, tid)).reviewed_at)
        response = await self.call("POST", "tasks/" + tid + "/submit-review", json={"note": "Review the delivery"})
        self.assertEqual(response.status_code, 200, response.text)
        await self.assert_pending_creator_review(tid)


if __name__ == "__main__":
    unittest.main()
