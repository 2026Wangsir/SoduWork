"""Project selection uses production device authentication and task write policy."""
import os
import unittest
from datetime import datetime, timezone

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")

from sqlalchemy import select

from app import automation_models as am, models
from app.deps import current_ai_client, current_client
from app.services import ai_exec, device_auth, tasks
import test_unified_requirements as fixtures


class RequirementProjectSelectionTests(unittest.IsolatedAsyncioTestCase):
    asyncTearDown = fixtures.UnifiedRequirementTests.asyncTearDown

    async def asyncSetUp(self):
        await fixtures.UnifiedRequirementTests.asyncSetUp(self)
        self.app.dependency_overrides.pop(current_client)
        self.app.dependency_overrides.pop(current_ai_client)
        async with self.sessions() as session:
            session.add(models.OrgUnit(id="team", name="Team", parent_id="company"))
            session.add(models.OrgUnit(id="subteam", name="Subteam", parent_id="team"))
            (await session.get(models.User, "owner")).org_id = "team"
            for pid, oid, status in (("own", "team", "active"), ("ancestor", "company", "active"),
                    ("child", "subteam", "active"), ("public", None, "active"),
                    ("foreign", "other", "active"), ("retired", "team", "archived")):
                session.add(models.Project(id=pid, name="Synthetic " + pid, org_id=oid, status=status))
            session.add_all([models.Repo(id="own-repo", project_id="own", name="Synthetic repository"),
                             models.Repo(id="other-repo", project_id="foreign", name="Other repository")])
            session.add(models.Client(id="second-device", user_ref="owner", auth_state="active"))
            await session.commit()
            self.tokens = {key: device_auth.issue_session(await session.get(models.Client, key))[0]
                           for key in ("owner", "peer", "outsider", "second-device")}

    async def call(self, method, path, who="owner", **kwargs):
        headers = {"Authorization": "Device " + self.tokens[who], **kwargs.pop("headers", {})}
        return await self.http.request(method, "/api/v1/" + path, headers=headers, **kwargs)

    async def snapshot(self, tid="private"):
        async with self.sessions() as session:
            task = await session.get(models.Task, tid)
            return {column.key: getattr(task, column.key) for column in models.Task.__table__.columns}

    async def test_candidates_and_explicit_create_share_active_organization_scope(self):
        response = await self.call("GET", "projects")
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual({row["id"] for row in response.json()}, {"own", "ancestor", "child", "public"})
        for pid in ("own", "ancestor", "child", "public"):
            created = await self.call("POST", "tasks", json={"title": "Synthetic selection", "projectId": pid})
            self.assertEqual(created.status_code, 200, created.text)
            self.assertEqual(created.json()["projectId"], pid)
            self.assertEqual(created.json()["repoId"], "")
        for pid in ("foreign", "retired", "missing", "project-personal-conversation"):
            denied = await self.call("POST", "tasks", json={"title": "Forbidden selection", "projectId": pid})
            self.assertEqual(denied.status_code, 404, denied.text)
        async with self.sessions() as session:
            self.assertEqual(list((await session.scalars(select(models.Task).where(
                models.Task.title == "Forbidden selection"))).all()), [])
        unauthenticated = await self.http.get("/api/v1/projects")
        self.assertEqual(unauthenticated.status_code, 401)

    async def test_owner_can_select_replace_and_clear_with_version(self):
        for pid, version in (("own", 1), ("child", 2), (None, 3)):
            changed = await self.call("PATCH", "tasks/private", json={"projectId": pid, "requirementVersion": version})
            self.assertEqual(changed.status_code, 200, changed.text)
            self.assertEqual(changed.json()["projectId"], pid)
            self.assertEqual(changed.json()["requirementVersion"], version + 1)
            self.assertEqual(changed.json()["repoId"], "")
        self.assertIsNone((await self.snapshot())["project_id"])

    async def test_invalid_and_stale_changes_are_atomic(self):
        for payload, expected in (({"projectId": "foreign", "requirementVersion": 1}, 404),
                ({"projectId": "retired", "requirementVersion": 1}, 404),
                ({"projectId": "missing", "requirementVersion": 1}, 404),
                ({"projectId": "own"}, 409),
                ({"projectId": "own", "requirementVersion": 0}, 409)):
            before = await self.snapshot()
            denied = await self.call("PATCH", "tasks/private", json={"title": "Must roll back", **payload})
            self.assertEqual(denied.status_code, expected, denied.text)
            self.assertEqual(await self.snapshot(), before)

    async def test_requirement_managers_and_same_user_other_device_cannot_change_project(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "shared")
            task.created_by = "peer"
            task.requester_user_id = "peer"
            await session.commit()
        for who, tid in (("peer", "shared"), ("second-device", "shared")):
            before = await self.snapshot(tid)
            denied = await self.call("PATCH", "tasks/" + tid, who, json={"projectId": "own", "requirementVersion": 1})
            self.assertEqual(denied.status_code, 403, denied.text)
            self.assertEqual(await self.snapshot(tid), before)
        detail = await self.call("GET", "tasks/shared", "peer")
        self.assertTrue(detail.json()["readOnly"])
        self.assertTrue(detail.json()["canEditRequirement"])

    async def test_account_switch_cannot_reuse_previous_device_authority(self):
        before = await self.snapshot()
        async with self.sessions() as session:
            client = await session.get(models.Client, "owner")
            client.user_ref = "peer"
            client.auth_version += 1
            await session.commit()
            switched = device_auth.issue_session(client)[0]
        stale = await self.call("PATCH", "tasks/private", json={"projectId": "own", "requirementVersion": 1})
        self.assertEqual(stale.status_code, 401, stale.text)
        current = await self.http.patch("/api/v1/tasks/private", headers={"Authorization": "Device " + switched},
            json={"projectId": "own", "requirementVersion": 1})
        self.assertIn(current.status_code, (403, 404), current.text)
        self.assertEqual(await self.snapshot(), before)

    async def test_execution_and_archival_freeze_project_even_when_request_resets_status(self):
        now = datetime.now(timezone.utc)
        async with self.sessions() as session:
            for key, values in (("started", {"actual_start_at": now}), ("archived", {"archived_at": now}),
                                ("history", {}), ("pending", {})):
                session.add(models.Task(id=key, title="Frozen definition", owner_client_id="owner",
                    created_by="owner", status="todo", **values))
            session.add(am.ExecutionSession(task_id="history", ref="synthetic-failed", state="failed", started_at=now))
            session.add(models.TaskEvent(task_id="pending", kind=ai_exec.EV_DISPATCH_STARTED,
                detail={"attemptId": "synthetic", "expectedRef": "synthetic-pending"}))
            await session.commit()
        for tid in ("started", "archived", "history", "pending"):
            before = await self.snapshot(tid)
            denied = await self.call("PATCH", "tasks/" + tid, json={"projectId": "own", "requirementVersion": 1,
                "status": "todo", "actualStart": None, "archivedAt": None})
            self.assertEqual(denied.status_code, 409, denied.text)
            self.assertEqual(await self.snapshot(tid), before)

    async def test_repository_pins_project_and_simultaneous_repo_changes_cannot_bypass(self):
        async with self.sessions() as session:
            task = await session.get(models.Task, "private")
            task.project_id, task.repo_id = "own", "own-repo"
            await session.commit()
        for payload in ({"projectId": None}, {"projectId": "child"},
                        {"projectId": "child", "repoId": ""}, {"projectId": "foreign", "repoId": "other-repo"}):
            before = await self.snapshot()
            denied = await self.call("PATCH", "tasks/private", json={**payload, "requirementVersion": 1})
            self.assertEqual(denied.status_code, 409, denied.text)
            self.assertEqual(await self.snapshot(), before)
        valid = await self.call("POST", "tasks", json={"title": "Aligned", "projectId": "own", "repoId": "own-repo"})
        self.assertEqual(valid.status_code, 200, valid.text)
        for rid in ("other-repo", "missing"):
            denied = await self.call("POST", "tasks", json={"title": "Mismatched", "projectId": "own", "repoId": rid})
            self.assertEqual(denied.status_code, 409, denied.text)

    async def test_legacy_unavailable_associations_and_repo_only_callers_remain_intact(self):
        for pid in ("retired", "foreign", "missing"):
            async with self.sessions() as session:
                task = await session.get(models.Task, "private")
                task.project_id, task.repo_id = pid, "legacy-repository"
                await session.commit()
            for payload in ({"note": "Ordinary edit"}, {"projectId": pid, "note": "Unchanged reference"}):
                changed = await self.call("PATCH", "tasks/private", json=payload)
                self.assertEqual(changed.status_code, 200, changed.text)
                self.assertEqual(changed.json()["projectId"], pid)
                self.assertEqual(changed.json()["repoId"], "legacy-repository")
        for path in ("tasks", "tasks/offline-synthetic"):
            created = await self.call("POST" if path == "tasks" else "PUT", path,
                json={"title": "Legacy repo-only", "repoId": "legacy-repository"})
            self.assertEqual(created.status_code, 200, created.text)
            self.assertIsNone(created.json()["projectId"])
            changed = await self.call("PATCH", "tasks/" + created.json()["id"], json={"repoId": "other-legacy-repository"})
            self.assertEqual(changed.status_code, 200, changed.text)
            self.assertEqual(changed.json()["repoId"], "other-legacy-repository")
        async with self.sessions() as session:
            imported = await tasks.create_task(session, "owner", {"title": "Administrative dispatch", "projectId": "foreign"},
                                               origin="dispatch", creator=("outsider", "Synthetic administrator"))
            self.assertEqual(imported["projectId"], "foreign")

    async def test_offline_put_and_batch_cannot_bypass_reference_validation(self):
        before = await self.snapshot()
        denied = await self.call("PUT", "tasks/private", json={"title": "Offline changed", "projectId": "foreign"})
        self.assertEqual(denied.status_code, 409, denied.text)
        self.assertEqual(await self.snapshot(), before)
        denied = await self.call("PATCH", "tasks/private", json={"projectId": "own", "repoId": "other-repo", "requirementVersion": 1})
        self.assertEqual(denied.status_code, 409, denied.text)
        self.assertEqual(await self.snapshot(), before)
        denied = await self.call("POST", "tasks/batch-update", json={"ids": ["private"],
            "patch": {"projectId": "foreign", "requirementVersion": 1}})
        self.assertEqual(denied.status_code, 404, denied.text)
        self.assertEqual(await self.snapshot(), before)

    async def test_whitespace_uses_validated_references_without_migrating_legacy_values(self):
        created = await self.call("POST", "tasks", json={"title": "Canonical references",
            "projectId": " own ", "repoId": " own-repo "})
        self.assertEqual(created.status_code, 200, created.text)
        self.assertEqual((created.json()["projectId"], created.json()["repoId"]), ("own", "own-repo"))
        tid = created.json()["id"]
        changed = await self.call("PATCH", "tasks/" + tid, json={"projectId": " own ", "repoId": " own-repo ",
            "note": "Unchanged associations", "requirementVersion": 1})
        self.assertEqual(changed.status_code, 200, changed.text)
        self.assertEqual((changed.json()["projectId"], changed.json()["repoId"]), ("own", "own-repo"))
        async with self.sessions() as session:
            legacy = await session.get(models.Task, "private")
            legacy.project_id, legacy.repo_id = " own ", " own-repo "
            await session.commit()
        unchanged = await self.call("PATCH", "tasks/private", json={"projectId": "own", "repoId": "own-repo",
            "note": "Keep historical references", "requirementVersion": 1})
        self.assertEqual(unchanged.status_code, 200, unchanged.text)
        self.assertEqual((unchanged.json()["projectId"], unchanged.json()["repoId"]), (" own ", " own-repo "))

    async def test_whitespace_cannot_bypass_invalid_project_or_repository_checks(self):
        for payload, status in (({"projectId": " foreign "}, 404), ({"projectId": " missing "}, 404),
                ({"projectId": "own", "repoId": " other-repo "}, 409),
                ({"projectId": "own", "repoId": " missing "}, 409)):
            created = await self.call("POST", "tasks", json={"title": "Rejected whitespace reference", **payload})
            self.assertEqual(created.status_code, status, created.text)
            before = await self.snapshot()
            denied = await self.call("PATCH", "tasks/private", json={**payload, "requirementVersion": 1})
            self.assertEqual(denied.status_code, status, denied.text)
            self.assertEqual(await self.snapshot(), before)


if __name__ == "__main__":
    unittest.main()
