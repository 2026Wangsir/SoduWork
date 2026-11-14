"""Isolated query-budget, lease, scope and migration regression tests."""
import importlib.util
import json
import os
import unittest
from datetime import timedelta
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("AUTH_SECRET", "isolated-native-discovery-tests")
os.environ.setdefault("ADMIN_PASS", "isolated-native-discovery-tests")
os.environ["CLUSTER_REDIS_URL"] = ""

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, event, inspect, select, func
from sqlalchemy.ext.asyncio import create_async_engine, async_sessionmaker
from app.db import Base
from app.models import Client, User, AppSetting
from app.remote_screen_models import RemoteScreenGrant
from app.account_conversation_models import AccountConversation, PersonalConversationRelay as Relay
from app.api import remote_screen as screen, personal_conversation_relay as relay
from app.services import native_discovery as discovery


class Redis:
    def __init__(self, clock):
        self.clock, self.values = clock, {}

    async def set(self, key, value, ex):
        self.values[key] = (value, self.clock() + ex)

    async def exists(self, key):
        return key in self.values and self.values[key][1] > self.clock()


def cluster(enabled=False, redis=None):
    return SimpleNamespace(enabled=enabled, healthy=True, redis=redis,
                           key=lambda kind, key: f"isolated:{kind}:{key}")


class PresenceTests(unittest.IsolatedAsyncioTestCase):
    async def test_quota_refresh_hint_is_scoped_and_protocol_two_only(self):
        message = {"t": "native-discovery", "protocol": 2, "topics": ["quota"]}
        self.assertEqual(discovery.heartbeat_topics(json.dumps(message)), ["quota"])
        self.assertIsNone(discovery.heartbeat_topics(json.dumps({**message, "protocol": 1})))
        from app.realtime import hub
        with patch.object(hub, "publish", new_callable=AsyncMock) as publish:
            await discovery.wake("device", "owner", "quota")
            publish.assert_awaited_once_with("device", {"type": "native-discovery", "topic": "quota"}, user_id="owner")

    async def test_local_lease_scope_expiry_and_memory_bound(self):
        time = [10.0]
        presence = discovery.Presence(cluster(), lambda: time[0], max_entries=2)
        await presence.touch("pc", "alice")
        self.assertTrue(await presence.available("pc", "alice"))
        self.assertFalse(await presence.available("pc", "bob"))
        self.assertFalse(await presence.available("other", "alice"))
        self.assertFalse(await presence.available("pc", "alice", 2))
        time[0] = 39.9
        self.assertTrue(await presence.available("pc", "alice"))
        time[0] = 40
        self.assertFalse(await presence.available("pc", "alice"))
        for device in ["a", "b", "c"]:
            await presence.touch(device, "alice")
        self.assertEqual(len(presence.entries), 2)

    async def test_cross_worker_lease_is_shared_and_redis_failure_never_falls_back(self):
        time = [1.0]
        shared = cluster(True, Redis(lambda: time[0]))
        first, second = discovery.Presence(shared), discovery.Presence(shared)
        await first.touch("pc", "alice")
        self.assertTrue(await second.available("pc", "alice"))
        self.assertFalse(await second.available("pc", "bob"))
        time[0] = 31
        self.assertFalse(await second.available("pc", "alice"))
        shared.healthy = False
        with self.assertRaises(discovery.PresenceUnavailable): await first.touch("pc", "alice")
        with self.assertRaises(discovery.PresenceUnavailable): await second.available("pc", "alice")
        self.assertEqual(len(first.entries), 0)

    async def test_heartbeat_uses_authenticated_binding_and_only_relay_advertises_execution(self):
        presence = discovery.Presence(cluster())
        with patch.object(discovery, "presence", presence):
            self.assertTrue(await discovery.heartbeat(json.dumps({"t": "native-discovery", "protocol": 1,
                "device": "victim", "owner": "victim", "topics": ["personal-relay"]}), "pc", "alice"))
            self.assertTrue(await presence.available("pc", "alice"))
            self.assertFalse(await presence.available("victim", "victim"))
            self.assertTrue(await discovery.heartbeat(json.dumps({"t": "native-discovery", "protocol": 1,
                "topics": ["remote-screen"]}), "screen-only", "alice"))
            self.assertFalse(await presence.available("screen-only", "alice"))
            for raw in ["{}", "[]", "not json", "x" * 513, json.dumps({"t": "native-discovery",
                    "protocol": 1, "topics": ["other"]})]:
                self.assertFalse(await discovery.heartbeat(raw, "pc", "alice"))

    async def test_wake_is_device_and_account_scoped(self):
        from app.realtime import Hub
        hub = Hub()
        # Real WebSockets are hashable; small test socket objects need that too.
        class Socket:
            def __init__(self): self.accept, self.send_json = AsyncMock(), AsyncMock()
        alice, bob, other = Socket(), Socket(), Socket()
        await hub.connect("pc", alice, user_id="alice")
        await hub.connect("pc", bob, user_id="bob")
        await hub.connect("other", other, user_id="alice")
        with patch("app.realtime.hub", hub):
            await discovery.wake("pc", "alice", "remote-screen")
        alice.send_json.assert_awaited_once_with({"type": "native-discovery", "topic": "remote-screen"})
        bob.send_json.assert_not_awaited()
        other.send_json.assert_not_awaited()

    async def test_websocket_wiring_throttles_heartbeats_and_keeps_authenticated_epoch(self):
        from fastapi import WebSocketDisconnect
        from app.api import ws as api
        from app.services import update_nudges
        class Session:
            async def __aenter__(self): return self
            async def __aexit__(self, *_): pass
        class Socket:
            def __init__(self): self.sent, self.calls = [], 0
            async def send_json(self, value): self.sent.append(value)
            async def receive_text(self):
                self.calls += 1
                if self.calls > 4: raise WebSocketDisconnect()
                if self.calls == 1: return '{"t":"ping"}'
                return json.dumps({"t": "native-discovery", "protocol": 1,
                    "device": "victim", "owner": "victim", "topics": ["personal-relay"]})
            async def close(self, **_): pass
        socket = Socket()
        hub = SimpleNamespace(connect=AsyncMock(return_value=True), disconnect=AsyncMock())
        device = SimpleNamespace(user_ref="alice", auth_version=7, app_version="test")
        touch = AsyncMock(return_value=True)
        times = iter([0, 5, 15])
        with patch.object(api, "SessionLocal", Session), patch.object(api, "hub", hub), \
             patch.object(api.device_auth, "client_from_transport", AsyncMock(return_value=device)), \
             patch.object(update_nudges, "latest_client_release", AsyncMock(return_value=None)), \
             patch.object(update_nudges, "nudge_stale_client", AsyncMock()), \
             patch.object(discovery.presence, "touch", touch), \
             patch.object(api, "time", SimpleNamespace(monotonic=lambda: next(times))):
            await api.ws(socket, "pc", secret="", device_session="isolated-session")
        self.assertEqual(touch.await_count, 2)
        touch.assert_awaited_with("pc", "alice", 7)
        self.assertEqual([row["type"] for row in socket.sent],
                         ["ready", "native-discovery-ready", "native-discovery-ready"])
        hub.disconnect.assert_awaited_once_with("pc", socket)


class QueryTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.engine = create_async_engine("sqlite+aiosqlite:///:memory:")
        async with self.engine.begin() as connection:
            await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[
                Client.__table__, User.__table__, AppSetting.__table__, RemoteScreenGrant.__table__,
                AccountConversation.__table__, Relay.__table__]))
        self.factory = async_sessionmaker(self.engine, expire_on_commit=False)
        self.session = self.factory()
        self.pc = Client(id="pc", user_ref="alice", auth_state="active", config={"keep": "unchanged"})
        self.phone = Client(id="phone", name="Phone", user_ref="alice", auth_state="active")
        self.session.add_all([self.pc, self.phone])
        await self.session.commit()
        self.statements, self.commits = [], []
        event.listen(self.engine.sync_engine, "before_cursor_execute", self.record)
        event.listen(self.engine.sync_engine, "commit", self.committed)
        self.presence = discovery.Presence(cluster())
        self.patcher = patch.object(discovery, "presence", self.presence)
        self.patcher.start()

    def record(self, _conn, _cursor, statement, _parameters, _context, _executemany):
        self.statements.append(statement)

    def committed(self, _conn): self.commits.append(True)

    def reset(self): self.statements.clear(); self.commits.clear()

    async def asyncTearDown(self):
        self.patcher.stop()
        await self.session.close()
        await self.engine.dispose()

    async def test_empty_screen_poll_is_one_read_and_no_commit(self):
        self.assertEqual(await screen.source_screen_requests(self.pc, self.session), {"items": []})
        self.assertEqual(len(self.statements), 1)
        self.assertIn("LIMIT", self.statements[0])
        self.assertEqual(self.commits, [])

    async def test_screen_sources_use_live_socket_presence_without_per_device_queries(self):
        self.phone.last_seen_at = screen._now() - timedelta(minutes=2)
        await self.session.commit()
        self.reset()
        with patch("app.realtime.hub.online_devices", return_value={"phone"}):
            result = await screen.screen_sources(self.pc, self.session)
        self.assertTrue(result["items"][0]["online"])
        self.assertEqual(len(self.statements), 1)
        self.assertIn("LIMIT", self.statements[0])

    async def test_empty_new_relay_poll_is_one_read_and_no_config_update(self):
        for _ in range(4):
            self.reset()
            result = await relay.poll(self.pc, self.session, {"discoveryProtocol": 1})
            self.assertEqual(result["requests"], [])
            self.assertEqual(len(self.statements), 1)
            self.assertEqual(self.commits, [])
        self.assertEqual(self.pc.config, {"keep": "unchanged"})
        self.assertTrue(await relay.available(self.pc))

    async def test_legacy_lease_remains_compatible_and_is_throttled_across_sessions(self):
        await relay.poll(self.pc, self.session)
        self.assertEqual(len(self.commits), 1)
        self.assertTrue(await relay.available(self.pc))
        stamp = self.pc.config[relay.PREFIX]["at"]
        # A different request/worker reads the same DB timestamp, not a local
        # last-written map. PostgreSQL serializes due renewals with FOR UPDATE.
        async with self.factory() as other:
            pc = await other.get(Client, "pc")
            self.reset()
            await relay.poll(pc, other)
            self.assertEqual(len(self.statements), 1)
            self.assertEqual(self.commits, [])
            self.assertEqual(pc.config[relay.PREFIX]["at"], stamp)
            self.assertEqual(pc.config["keep"], "unchanged")

    async def test_screen_poll_does_not_let_expired_history_hide_live_grants(self):
        now = screen._now()
        for index in range(130):
            self.session.add(RemoteScreenGrant(id=f"g{index:04}", owner_user_id="alice", source_client_id="pc",
                viewer_client_id="phone", state="pending", expires_at=now + timedelta(seconds=60 if index >= 100 else -1)))
        await self.session.commit()
        self.reset()
        result = await screen.source_screen_requests(self.pc, self.session)
        self.assertEqual(len(result["items"]), 20)
        self.assertTrue(all(int(row["id"][1:]) >= 100 for row in result["items"]))
        self.assertEqual(len(self.statements), 2)
        self.assertEqual(self.commits, [])

    async def test_screen_creation_cleans_a_bounded_batch_and_wakes_after_commit(self):
        for index in range(110):
            self.session.add(RemoteScreenGrant(id=f"old{index}", owner_user_id="alice", source_client_id="pc",
                viewer_client_id="phone", state="pending", expires_at=screen._now() - timedelta(seconds=1)))
        await self.session.commit()
        self.reset()
        async def wake(device, owner, topic):
            self.assertEqual(self.commits, [True])
            self.assertFalse(self.session.in_transaction())
            self.assertEqual((device, owner, topic), ("pc", "alice", "remote-screen"))
        with patch.object(discovery, "wake", side_effect=wake):
            await screen.create_screen_request({"sourceClientId": "pc"}, self.phone, self.session)
        self.assertEqual(await self.session.scalar(select(func.count()).select_from(RemoteScreenGrant).where(
            RemoteScreenGrant.state == "expired")), 100)

    async def test_twenty_relay_jobs_use_one_batched_source_lookup(self):
        for index in range(20):
            self.session.add(AccountConversation(id=f"c{index}", owner_user_id="alice", source_client_id="pc",
                source_session_id=f"native{index}", source_epoch="e", source_revision=1, revision=1, state="idle"))
            self.session.add(Relay(id=f"r{index}", owner_user_id="alice", requester_client_id="phone", source_client_id="pc",
                conversation_id=f"c{index}", active_conversation_id=f"c{index}", request_id=f"request{index}",
                request_hash="hash", instruction="hello", source_epoch="e", source_revision=1, phase="prepared",
                expires_at=relay.now() + timedelta(seconds=60)))
        await self.session.commit()
        self.reset()
        result = await relay.poll(self.pc, self.session, {"discoveryProtocol": 1})
        self.assertEqual(len(result["requests"]), 20)
        self.assertEqual(len(self.statements), 2)
        self.assertEqual(self.commits, [])


class MigrationTests(unittest.TestCase):
    def test_index_upgrade_and_downgrade(self):
        file = Path(__file__).parent / "migrations/versions/0079_native_discovery.py"
        spec = importlib.util.spec_from_file_location("native_discovery_migration", file)
        module = importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        engine = create_engine("sqlite://")
        try:
            with engine.begin() as connection:
                connection.exec_driver_sql("CREATE TABLE remote_screen_grant (source_client_id TEXT, state TEXT, expires_at TEXT)")
                with Operations.context(MigrationContext.configure(connection)):
                    module.upgrade()
                    self.assertEqual(inspect(connection).get_indexes("remote_screen_grant")[0]["column_names"],
                                     ["source_client_id", "state", "expires_at"])
                    module.downgrade()
                    self.assertEqual(inspect(connection).get_indexes("remote_screen_grant"), [])
        finally: engine.dispose()


if __name__ == "__main__": unittest.main()
