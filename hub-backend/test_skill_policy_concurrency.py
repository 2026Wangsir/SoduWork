"""Isolated policy endpoint/cache regression: no production accounts or database."""
import os
os.environ["DATABASE_URL"] = "sqlite+aiosqlite:///:memory:"
os.environ["CLUSTER_REDIS_URL"] = ""

import asyncio
import tempfile
import threading
import time
import unittest
from types import SimpleNamespace
from unittest.mock import patch

import httpx
from fastapi import FastAPI
from app import models
from app.api import tasks
from app.db import get_session
from app.deps import current_client
from app.services import skills, skill_packages
from skill_test_support import fixture


async def until(predicate):
    async with asyncio.timeout(3):
        while not predicate():
            await asyncio.sleep(.005)


class ScanConcurrency(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        skills.clear_scan_cache()
        self.roots = patch.object(skills, "default_roots", return_value=[])
        self.roots.start()
        self.revision = patch.object(skill_packages, "index_revision", return_value="unit-fixture")
        self.revision.start()

    def tearDown(self):
        self.roots.stop()
        self.revision.stop()
        skills.clear_scan_cache()

    async def test_different_owners_progress_without_global_disk_lock(self):
        started, release, calls = set(), threading.Event(), []
        def scan(extra_roots=None, owner_client_id=""):
            calls.append(owner_client_id); started.add(owner_client_id)
            release.wait(3)
            return [{"name": "private", "ownerClientId": owner_client_id,
                     "resourceKinds": ["reference"]}]
        with patch.object(skills, "scan", scan):
            a = asyncio.create_task(skills.scan_async([], "alice"))
            shared = asyncio.create_task(skills.scan_async([], "alice"))
            b = asyncio.create_task(skills.scan_async([], "bob"))
            try:
                await until(lambda: len(started) == 2)
                self.assertFalse(a.done())
                self.assertEqual(sorted(calls), ["alice", "bob"])
            finally:
                release.set()
                first, again, other = await asyncio.gather(a, shared, b)
            self.assertEqual(first, again)
            self.assertNotEqual(first[0]["ownerClientId"], other[0]["ownerClientId"])
            first[0]["resourceKinds"].append("mutated")
            self.assertEqual((await skills.scan_async([], "alice"))[0]["resourceKinds"], ["reference"])

    async def test_clear_during_scan_prevents_late_stale_cache_fill(self):
        started, release = threading.Event(), threading.Event()
        count = 0
        def scan(*args):
            nonlocal count
            count += 1
            if count == 1:
                started.set(); release.wait(3)
                return [{"name": "deleted"}]
            return [{"name": "replacement"}]
        with patch.object(skills, "scan", scan):
            old = asyncio.create_task(skills.scan_async([], "alice"))
            try:
                await until(started.is_set)
                skills.clear_scan_cache()
                self.assertEqual((await skills.scan_async([], "alice"))[0]["name"], "replacement")
            finally:
                release.set(); await old
            self.assertEqual((await skills.scan_async([], "alice"))[0]["name"], "replacement")
            self.assertEqual(count, 2)

    async def test_cancelled_waiter_does_not_cancel_shared_scan(self):
        started, release = threading.Event(), threading.Event()
        def scan(*args):
            started.set(); release.wait(3)
            return [{"name": "retained"}]
        with patch.object(skills, "scan", scan):
            cancelled = asyncio.create_task(skills.scan_async([], "alice"))
            other = asyncio.create_task(skills.scan_async([], "alice"))
            try:
                await until(started.is_set)
                cancelled.cancel()
                with self.assertRaises(asyncio.CancelledError): await cancelled
            finally:
                release.set()
            self.assertEqual((await other)[0]["name"], "retained")

    async def test_runner_metadata_stays_on_event_loop_and_is_not_cached(self):
        current_thread = threading.get_ident()
        client = SimpleNamespace(id="alice")
        values = [{"name": "local-first", "scope": "local"}]
        def runner(_client):
            self.assertEqual(threading.get_ident(), current_thread)
            return [dict(item) for item in values]
        with patch.object(skills, "scan", return_value=[]), patch.object(skills, "runner_items", runner):
            first = await skills.available_for_client_async([], client)
            values[:] = [{"name": "local-second", "scope": "local"}]
            second = await skills.available_for_client_async([], client)
        self.assertEqual(first[0]["name"], "local-first")
        self.assertEqual(second[0]["name"], "local-second")

    async def test_shared_index_reads_are_off_event_loop_even_for_hot_cache(self):
        loop_thread = threading.get_ident()
        threads = []
        def revision():
            threads.append(threading.get_ident())
            self.assertNotEqual(threads[-1], loop_thread)
            return "revision"
        async def cfg(_): return {"allowed": [], "roots": []}
        with patch.object(skill_packages, "index_revision", revision), patch.object(skills, "_read_cfg", cfg), \
                patch.object(skills, "scan", return_value=[]) as scan:
            await skills.catalog_with_policy(None)
            await skills.catalog_with_policy(None)
            await skills.scan_async()
        self.assertEqual(scan.call_count, 1, "fresh index checks must not repeatedly walk SKILL metadata")
        self.assertEqual(len(threads), 5)

    async def test_cache_is_bounded(self):
        with patch.object(skills, "_SCAN_CACHE_MAX_ITEMS", 3), patch.object(skills, "scan", return_value=[]):
            for index in range(6): await skills.scan_async([], str(index))
        self.assertEqual(len(skills._SCAN_CACHE), 3)

    async def test_changed_roots_are_rescanned_before_authorization(self):
        state = {"allowed": ["same-name"], "roots": ["old-root"]}
        started, release, calls = threading.Event(), threading.Event(), []
        async def cfg(_): return {**state, "roots": list(state["roots"])}
        def scan(roots, owner):
            calls.append(roots[0])
            if roots == ["old-root"]:
                started.set(); release.wait(3)
            return [{"name": "same-name", "path": roots[0]}]
        with patch.object(skills, "_read_cfg", cfg), patch.object(skills, "scan", scan):
            pending = asyncio.create_task(skills.catalog_with_policy(None))
            try:
                await until(started.is_set)
                state["roots"] = ["new-root"]
            finally: release.set()
            policy, rows = await pending
        self.assertEqual(calls, ["old-root", "new-root"])
        self.assertEqual(rows[0]["path"], "new-root")
        self.assertEqual(policy["roots"], ["new-root"])

    async def test_repeated_directory_invalidation_fails_closed_after_three_scans(self):
        async def cfg(_): return {"allowed": ["stale"], "roots": []}
        def invalidated_scan(*args):
            skills.clear_scan_cache()
            return [{"name": "stale"}]
        with patch.object(skills, "_read_cfg", cfg), patch.object(skills, "scan", side_effect=invalidated_scan) as scan:
            with self.assertRaises(skills.PolicyChanged):
                await skills.catalog_with_policy(None)
        self.assertEqual(scan.call_count, 3, "directory churn must never cause an unbounded retry loop")

    async def test_slow_skills_http_request_does_not_block_other_requests(self):
        app = FastAPI()
        app.include_router(tasks.router)
        app.dependency_overrides[current_client] = lambda: SimpleNamespace(id="alice", skills=[])
        app.dependency_overrides[get_session] = lambda: None
        @app.get("/fixture/ping")
        async def ping(): return {"ok": True}
        started, release = threading.Event(), threading.Event()
        def slow(*args):
            started.set(); release.wait(3)
            return [{"name": "company", "description": "fixture", "scope": "company"}]
        async def cfg(_session): return {"allowed": ["company"], "roots": []}
        with patch.object(skills, "scan", slow), patch.object(skills, "_read_cfg", cfg), \
                patch.object(skills, "runner_items", return_value=[]):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as http:
                pending = asyncio.create_task(http.get("/api/v1/skills"))
                try:
                    await until(started.is_set)
                    self.assertEqual((await http.get("/fixture/ping")).status_code, 200)
                    self.assertFalse(pending.done(), "ping completes while the disk scan is still blocked")
                finally:
                    release.set()
                    response = await pending
                self.assertEqual(response.status_code, 200)
                self.assertEqual(response.json()["skills"][0]["name"], "company")

    async def test_http_timing_against_previous_synchronous_scan(self):
        app = FastAPI()
        app.include_router(tasks.router)
        app.dependency_overrides[current_client] = lambda: SimpleNamespace(id="alice", skills=[])
        app.dependency_overrides[get_session] = lambda: None
        @app.get("/fixture/ping")
        async def ping(): return {"ok": True}
        async def cfg(_session): return {"allowed": [], "roots": []}
        started = threading.Event()
        def slow(*args, **kwargs):
            started.set()
            time.sleep(.25)
            return []
        async def old_scan(roots, client, **_kwargs):
            return skills.available_for_client(roots, client)
        async def measure(http):
            started.clear()
            start = time.perf_counter()
            pending = asyncio.create_task(http.get("/api/v1/skills"))
            await until(started.is_set)
            self.assertEqual((await http.get("/fixture/ping")).status_code, 200)
            ping_elapsed = time.perf_counter() - start
            await pending
            return ping_elapsed
        with patch.object(skills, "scan", slow), patch.object(skills, "_read_cfg", cfg), \
                patch.object(skills, "runner_items", return_value=[]):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as http:
                with patch.object(skills, "available_for_client_async", old_scan):
                    baseline = await measure(http)
                improved = await measure(http)
        print("\nSame /skills ASGI request, 250 ms disk delay: unrelated ping old=%.1f ms async=%.1f ms" %
              (baseline * 1000, improved * 1000), flush=True)
        self.assertGreaterEqual(baseline, .25)
        self.assertLess(improved, baseline)


class SharedIndexRevision(unittest.TestCase):
    def test_fingerprint_uses_content_even_with_identical_file_metadata(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-index-revision-") as root, \
                patch.object(skill_packages, "_data_root", return_value=root):
            self.assertEqual(skill_packages.index_revision(), "missing")
            skill_packages._save_index({"items": [], "revision": 1})
            before = skill_packages.index_revision()
            stamp = os.stat(skill_packages._index_path())
            skill_packages._save_index({"items": [], "revision": 2})
            os.utime(skill_packages._index_path(), ns=(stamp.st_atime_ns, stamp.st_mtime_ns))
            self.assertEqual(os.stat(skill_packages._index_path()).st_size, stamp.st_size)
            self.assertNotEqual(skill_packages.index_revision(), before)
            with patch("builtins.open", side_effect=PermissionError("fixture unreadable index")):
                with self.assertRaises(PermissionError):
                    skill_packages.index_revision()


class LivePolicyIsolation(unittest.IsolatedAsyncioTestCase):
    async def test_other_hub_index_changes_invalidate_hot_and_inflight_packages_without_local_clear(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-policy-shared-index-") as root:
            app, tokens, sessions, cleanup = await fixture(root)
            release = threading.Event()
            try:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture",
                        headers={"Authorization": "Device " + tokens["alice"]}) as http:
                    versions = []
                    for label in ("First version.", "Second version."):
                        created = await http.post("/api/v1/skills/create", json={
                            "name": "shared-index", "description": "Fixture", "instructions": label})
                        self.assertEqual(created.status_code, 200, created.text)
                        versions.append(skill_packages._load_index())
                    async def other_hub_publish(index):
                        generation = skills._SCAN_GENERATION
                        # A second Hub shares the file, but cannot clear this worker's memory.
                        await asyncio.to_thread(skill_packages._save_index, index)
                        self.assertEqual(skills._SCAN_GENERATION, generation)
                    original = skills.scan
                    for inflight in (False, True):
                        with self.subTest(inflight=inflight):
                            await other_hub_publish(versions[0])
                            skills.clear_scan_cache()  # Arrange only; the remote changes below never clear it.
                            started, release = threading.Event(), threading.Event()
                            calls = []
                            def delayed_scan(*args):
                                rows = original(*args)
                                calls.append(rows)
                                if inflight and len(calls) == 1:
                                    started.set(); release.wait(10)
                                return rows
                            with patch.object(skills, "scan", delayed_scan):
                                pending = None
                                try:
                                    if inflight:
                                        pending = asyncio.create_task(http.post("/api/v1/skills/runtime",
                                                                                json={"names": ["shared-index"]}))
                                        await until(started.is_set)
                                    else:
                                        warm = await http.post("/api/v1/skills/runtime", json={"names": ["shared-index"]})
                                        self.assertEqual(warm.status_code, 200)
                                        self.assertEqual(len(calls), 1)
                                    await other_hub_publish({"schemaVersion": 1, "items": []})
                                finally:
                                    release.set()
                                if pending is not None:
                                    self.assertEqual((await pending).status_code, 404, "old scan must not return a removed package")
                                denied = await http.post("/api/v1/skills/runtime", json={"names": ["shared-index"]})
                                self.assertEqual(denied.status_code, 404, "hot cache must not return a removed package")
                                await other_hub_publish(versions[1])
                                listing = (await http.get("/api/v1/skills")).json()["skills"]
                                row = next(item for item in listing if item["name"] == "shared-index")
                                self.assertEqual(row["checksum"], versions[1]["items"][0]["packageChecksum"])
                                self.assertNotEqual(row["checksum"], versions[0]["items"][0]["packageChecksum"])
                                self.assertEqual((await http.post("/api/v1/skills/runtime",
                                                               json={"names": ["shared-index"]})).status_code, 200)
                                foreign = (await http.get("/api/v1/skills", headers={
                                    "Authorization": "Device " + tokens["bob"]})).json()["skills"]
                                self.assertNotIn("shared-index", [item["name"] for item in foreign])
            finally:
                release.set()
                await cleanup()

    async def test_shared_index_read_failure_never_reuses_cached_package(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-policy-index-error-") as root:
            app, tokens, sessions, cleanup = await fixture(root)
            try:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture",
                        headers={"Authorization": "Device " + tokens["alice"]}) as http:
                    created = await http.post("/api/v1/skills/create", json={
                        "name": "read-failure", "description": "Fixture", "instructions": "Fixture only."})
                    self.assertEqual(created.status_code, 200)
                    self.assertEqual((await http.post("/api/v1/skills/runtime",
                                                     json={"names": ["read-failure"]})).status_code, 200)
                    with patch.object(skill_packages, "index_revision", side_effect=PermissionError("fixture private path")):
                        for path in ("/api/v1/skills", "/api/v1/capabilities", "/api/v1/skills/runtime"):
                            result = (await http.post(path, json={"names": ["read-failure"]}) if path.endswith("runtime")
                                      else await http.get(path))
                            self.assertEqual(result.status_code, 409)
                            self.assertNotIn("fixture private path", result.text)
                    index = skill_packages._index_path()
                    replacement = index + ".fixture-invalid"
                    with open(replacement, "w", encoding="utf-8") as handle:
                        handle.write("not valid JSON")
                    os.replace(replacement, index)
                    self.assertEqual((await http.post("/api/v1/skills/runtime",
                                                     json={"names": ["read-failure"]})).status_code, 409)
            finally:
                await cleanup()

    async def test_deleted_personal_package_cannot_escape_through_inflight_materialization(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-policy-deleted-race-") as root:
            app, tokens, sessions, cleanup = await fixture(root)
            started, release = threading.Event(), threading.Event()
            original, calls = skills.scan, []
            def delayed_scan(*args):
                rows = original(*args)
                calls.append(rows)
                if len(calls) == 1:
                    started.set()
                    release.wait(10)
                return rows
            try:
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture",
                        headers={"Authorization": "Device " + tokens["alice"]}) as http:
                    created = await http.post("/api/v1/skills/create", json={
                        "name": "deleted-race", "description": "Fixture", "instructions": "Fixture only."})
                    self.assertEqual(created.status_code, 200, created.text)
                    details = (await http.get("/api/v1/skills/deleted-race/details")).json()
                    skills.clear_scan_cache()
                    with patch.object(skills, "scan", delayed_scan):
                        pending = asyncio.create_task(http.post("/api/v1/skills/runtime", json={"names": ["deleted-race"]}))
                        try:
                            await until(started.is_set)
                            deleted = await http.request("DELETE", "/api/v1/skills/deleted-race",
                                                         json={"checksum": details["checksum"]})
                            self.assertEqual(deleted.status_code, 200, deleted.text)
                        finally:
                            release.set()
                        response = await pending
                        self.assertEqual(response.status_code, 404, "the original waiter must not return the deleted package")
                        fresh = await http.post("/api/v1/skills/runtime", json={"names": ["deleted-race"]})
                        self.assertEqual(fresh.status_code, 404)
                        self.assertTrue(any(row["name"] == "deleted-race" for row in calls[0]))
                        self.assertGreaterEqual(len(calls), 2, "invalidation must require a fresh directory before authorizing")
            finally:
                release.set()
                await cleanup()

    async def test_revocation_committed_during_scan_blocks_inflight_reads_and_execution(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-policy-revoke-") as root:
            app, tokens, sessions, cleanup = await fixture(root)
            started, release = threading.Event(), threading.Event()
            def slow(*args):
                started.set(); release.wait(10)
                return [{"name": "company", "description": "Fixture", "scope": "company"}]
            async def execute(named):
                async with sessions() as session:
                    client = await session.get(models.Client, "device-alice")
                    if named: return await skills.resolve_named(session, ["company"], client)
                    return await skills.resolve(session, client=client)
            try:
                async with sessions() as session:
                    await skills.save_cfg(session, {"allowed": ["company"]})
                    client = await session.get(models.Client, "device-alice")
                    client.skills = ["company"]
                    await session.commit()
                with patch.object(skills, "scan", slow), patch.object(skills, "runner_items", return_value=[]):
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture",
                                                 headers={"Authorization": "Device " + tokens["alice"]}) as http:
                        jobs = [asyncio.create_task(call) for call in (
                            http.get("/api/v1/skills"), http.get("/api/v1/capabilities"),
                            http.put("/api/v1/skills", json={"enabled": ["company"]}),
                            http.post("/api/v1/skills/runtime", json={"names": ["company"]}),
                            execute(False), execute(True))]
                        try:
                            await until(started.is_set)
                            await asyncio.sleep(.05)
                            async with sessions() as session:
                                await skills.save_cfg(session, {"allowed": []})
                                await session.commit()
                        finally:
                            release.set()
                            result = await asyncio.gather(*jobs, return_exceptions=True)
                        self.assertEqual(result[0].json()["enabled"], [])
                        self.assertIn("company", result[0].json()["revoked"])
                        self.assertFalse(result[1].json()["skills"][0]["available"])
                        self.assertEqual(result[2].json()["enabled"], [])
                        self.assertEqual(result[3].status_code, 404)
                        self.assertEqual(result[4], [])
                        self.assertIsInstance(result[5], ValueError)
                        self.assertIn("管理员尚未开放", str(result[5]))
            finally:
                release.set()
                await cleanup()

    async def test_real_database_revocation_selection_and_personal_owner_remain_live(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-policy-isolation-") as root:
            app, tokens, sessions, cleanup = await fixture(root)
            scan_calls = []
            def catalog(extra_roots=None, owner_client_id=""):
                scan_calls.append(owner_client_id)
                return [{"name": "company", "description": "Shared metadata", "scope": "company"},
                        {"name": "own-" + owner_client_id, "description": "Owner metadata",
                         "scope": "personal", "ownerClientId": owner_client_id}]
            try:
                async with sessions() as session:
                    await skills.save_cfg(session, {"allowed": ["company"]})
                    alice = await session.get(models.Client, "device-alice")
                    alice.skills = ["company"]
                    await session.commit()
                with patch.object(skills, "scan", catalog), patch.object(skills, "runner_items", return_value=[]):
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture") as http:
                        headers = {"Authorization": "Device " + tokens["alice"]}
                        before = (await http.get("/api/v1/skills", headers=headers)).json()
                        self.assertEqual(before["enabled"], ["company"])
                        async with sessions() as session:
                            await skills.save_cfg(session, {"allowed": []})
                            await session.commit()
                        after = (await http.get("/api/v1/skills", headers=headers)).json()
                        self.assertEqual(after["enabled"], [])
                        self.assertEqual(after["revoked"], ["company"])
                        self.assertEqual(scan_calls, ["device-alice"], "metadata cache must not cache authorization")
                        selected = await http.put("/api/v1/skills", headers=headers, json={"enabled": ["company", "own-device-alice"]})
                        self.assertEqual(selected.json()["enabled"], ["own-device-alice"])
                        listing = (await http.get("/api/v1/capabilities", headers=headers)).json()
                        shared = next(item for item in listing["skills"] if item["name"] == "company")
                        self.assertFalse(shared["available"])
                        bob = (await http.get("/api/v1/skills", headers={"Authorization": "Device " + tokens["bob"]})).json()
                        self.assertEqual([item["name"] for item in bob["skills"]], ["own-device-bob"])
                        async with sessions() as session:
                            alice = await session.get(models.Client, "device-alice")
                            with self.assertRaisesRegex(ValueError, "管理员尚未开放"):
                                await skills.resolve_named(session, ["company"], alice)
            finally:
                await cleanup()

    async def test_materialization_cannot_treat_runner_only_metadata_as_a_hub_package(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-policy-materialize-") as root:
            app, tokens, sessions, cleanup = await fixture(root)
            try:
                async with sessions() as session:
                    await skills.save_cfg(session, {"allowed": ["runner-only"]})
                    await session.commit()
                local = [{"name": "runner-only", "scope": "local", "path": ""}]
                with patch.object(skills, "scan", return_value=[]), patch.object(skills, "runner_items", return_value=local):
                    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://fixture",
                            headers={"Authorization": "Device " + tokens["alice"]}) as http:
                        listing = await http.get("/api/v1/skills")
                        self.assertEqual(listing.json()["skills"][0]["name"], "runner-only")
                        response = await http.post("/api/v1/skills/runtime", json={"names": ["runner-only"]})
                        self.assertEqual(response.status_code, 404)
            finally:
                await cleanup()


if __name__ == "__main__":
    unittest.main()
