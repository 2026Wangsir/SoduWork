"""Real local ASGI HTTP/WebSocket compatibility with signed device sessions.

Only the database/transport fixture is substituted. Authentication, token
verification, inbox/claim/state handlers, transaction hooks and socket routing
are the production implementations. No model, external service or live DB is used.
"""
import asyncio
import json
import os
import tempfile
import unittest
from contextlib import ExitStack, asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-client-push-compatibility-tests")
os.environ.setdefault("ADMIN_PASS", "isolated-client-push-compatibility-tests")

import anyio
from fastapi import FastAPI
from fastapi.testclient import TestClient
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from starlette.websockets import WebSocket, WebSocketDisconnect

from app import models
from app.api import personal_schedules, ws as websocket_api
from app.db import Base, get_session
from app.realtime import Hub
from app.services import automation_inbox_events, device_auth, native_discovery
from app.services import schedule_conversations


class FirstFrameDisconnectTests(unittest.IsolatedAsyncioTestCase):
    async def first_frame(self, frame, *, close_error=None):
        """Use Starlette's real state transitions and production auth parsing.

        The ASGI transport rejects sends after receiving a peer disconnect, as
        Uvicorn does when its connection has already completed.
        """
        incoming = asyncio.Queue()
        incoming.put_nowait({"type": "websocket.connect"})
        if frame is not None:
            incoming.put_nowait(frame)
        sent, peer_disconnected = [], False

        async def receive():
            nonlocal peer_disconnected
            message = await incoming.get()
            peer_disconnected = message["type"] == "websocket.disconnect"
            return message

        async def send(message):
            if peer_disconnected:
                raise RuntimeError("Unexpected ASGI message 'websocket.close', after sending "
                                   "'websocket.close' or response already completed.")
            if message["type"] == "websocket.close" and close_error:
                raise close_error
            sent.append(message)

        socket = WebSocket({"type": "websocket", "path": "/api/v1/ws"}, receive, send)
        with patch.object(websocket_api, "SessionLocal", side_effect=AssertionError("Unauthenticated DB access")):
            await websocket_api.ws(socket, "compat-pc", secret=None, device_session=None)
        return sent

    async def test_peer_disconnect_before_auth_does_not_send_another_close(self):
        sent = await self.first_frame({"type": "websocket.disconnect", "code": 1000})
        self.assertEqual([message["type"] for message in sent], ["websocket.accept"])

    async def test_connected_invalid_auth_frame_still_closes_with_4401(self):
        for text in ("invalid JSON", '{"t":"not-auth"}',
                     '{"t":"auth","device":"another-device","session":"invalid"}'):
            with self.subTest(text=text):
                sent = await self.first_frame({"type": "websocket.receive", "text": text})
                self.assertEqual(sent[-1], {"type": "websocket.close", "code": 4401, "reason": ""})

    async def test_connected_auth_timeout_still_closes_with_4401(self):
        with patch.object(device_auth, "WS_AUTH_FRAME_TIMEOUT", 0.01):
            sent = await self.first_frame(None)
        self.assertEqual(sent[-1], {"type": "websocket.close", "code": 4401, "reason": ""})

    async def test_unrelated_close_transport_error_is_not_suppressed(self):
        with self.assertRaisesRegex(RuntimeError, "unrelated transport failure"):
            await self.first_frame({"type": "websocket.receive", "text": "invalid JSON"},
                                   close_error=RuntimeError("unrelated transport failure"))


class ClientPushCompatibilityTests(unittest.TestCase):
    def setUp(self):
        self.resources = ExitStack()
        self.addCleanup(self.resources.close)
        directory = self.resources.enter_context(tempfile.TemporaryDirectory(prefix="client-push-compat-"))
        self.engine = create_async_engine("sqlite+aiosqlite:///" + str(Path(directory) / "test.db"))
        self.sessions = async_sessionmaker(self.engine, expire_on_commit=False)
        self.tokens = {}
        self.hub = Hub()
        cluster = SimpleNamespace(enabled=False, healthy=True,
                                  key=lambda kind, value="": f"isolated-compat:{kind}:{value}")
        self.resources.enter_context(patch("app.realtime.hub", self.hub))
        self.resources.enter_context(patch.object(websocket_api, "hub", self.hub))
        self.resources.enter_context(patch.object(websocket_api, "SessionLocal", self.sessions))
        self.resources.enter_context(patch("app.services.cluster_bus.bus", cluster))
        self.resources.enter_context(patch.object(native_discovery, "bus", cluster))
        self.resources.enter_context(patch.object(native_discovery, "presence", native_discovery.Presence(cluster)))

        @asynccontextmanager
        async def lifespan(_app):
            async with self.engine.begin() as connection:
                await connection.run_sync(lambda sync: Base.metadata.create_all(sync, tables=[
                    models.User.__table__, models.Client.__table__, models.AppSetting.__table__,
                    models.ClientRelease.__table__, models.AiSchedule.__table__, models.AiScheduleRun.__table__]))
            automation_inbox_events.start()
            try:
                async with self.sessions() as session:
                    session.add_all([models.User(id=owner, username=owner, is_active=True)
                                     for owner in ("alice", "bob")])
                    for device, owner in (("compat-pc", "alice"), ("compat-phone", "alice"),
                                          ("compat-bob", "bob")):
                        row = models.Client(id=device, user_ref=owner, auth_state="active", auth_version=1,
                            app_version="1.13.12", config={"automationConversationV1": 1})
                        session.add(row)
                        self.tokens[device] = device_auth.issue_session(row)[0]
                    await session.flush()
                    session.add(models.AiSchedule(id="compat-plan", owner_client_id="compat-pc",
                        title="Previously authorized automation", note="Original bounded prompt",
                        assignee_id="local:pi", enabled=False))
                    await session.commit()
                yield
            finally:
                await automation_inbox_events.stop()
                await self.engine.dispose()

        self.app = FastAPI(lifespan=lifespan)
        self.app.include_router(personal_schedules.router, prefix="/api/v1")
        self.app.include_router(websocket_api.router)

        async def isolated_session():
            async with self.sessions() as session:
                yield session

        # Preserve current_client/authenticated_client and all real auth checks.
        self.app.dependency_overrides[get_session] = isolated_session
        self.http = self.resources.enter_context(TestClient(self.app))

    def headers(self, device="compat-pc", token=None):
        return {"Authorization": "Device " + (token or self.tokens[device])}

    def inbox(self, device="compat-pc", token=None):
        return self.http.post("/api/v1/automation-conversations/inbox", json={},
                              headers=self.headers(device, token))

    def socket(self, device="compat-pc", token=None):
        socket = self.resources.enter_context(self.http.websocket_connect("/api/v1/ws?device=" + device))
        socket.send_json({"t": "auth", "device": device, "session": token or self.tokens[device]})
        self.assertEqual(self.receive(socket), {"type": "ready", "device": device})
        return socket

    @staticmethod
    def receive(socket):
        async def bounded_receive():
            with anyio.fail_after(3):
                return await socket._send_rx.receive()
        message = socket.portal.call(bounded_receive)
        if message["type"] == "websocket.close":
            raise WebSocketDisconnect(message.get("code", 1000))
        return json.loads(message["text"])

    def quiet(self, socket):
        async def next_message():
            try:
                return socket._send_rx.receive_nowait()
            except anyio.WouldBlock:
                return None
        self.assertIsNone(socket.portal.call(next_message), "unexpected cross-device/account or rolled-back event")

    def drain(self):
        self.http.portal.call(automation_inbox_events.flush_for_test)

    def prepare(self, run_id="compat-run", *, commit=True):
        async def transaction():
            async with self.sessions() as session:
                client = await session.get(models.Client, "compat-pc")
                plan = await session.get(models.AiSchedule, "compat-plan")
                session.add(models.AiScheduleRun(id=run_id, schedule_id=plan.id,
                    owner_client_id=client.id, state="waiting", receipt={}))
                await session.flush()
                await schedule_conversations.prepare(session, plan, client, None, run_id, "pi", {})
                if commit:
                    await session.commit()
                else:
                    await session.rollback()
            await automation_inbox_events.flush_for_test()
        # Exercise the scheduler's real transaction path on the same ASGI loop;
        # no execution substrate or model call is needed to prepare an inbox row.
        self.http.portal.call(transaction)

    def test_legacy_v1_ack_and_inbox_http_shape_are_unchanged(self):
        socket = self.socket()
        socket.send_json({"t": "native-discovery", "protocol": 1,
                          "topics": ["remote-screen", "personal-relay"]})
        self.assertEqual(self.receive(socket), {"type": "native-discovery-ready", "protocol": 1})
        reply = self.inbox()
        self.assertEqual(reply.status_code, 200, reply.text)
        self.assertEqual(reply.json(), {"items": []})
        self.assertEqual(self.app.dependency_overrides.keys(), {get_session})

    def test_v2_ack_is_explicit_and_does_not_change_v1_on_the_same_socket(self):
        socket = self.socket()
        socket.send_json({"t": "native-discovery", "protocol": 2,
            "topics": ["automation-inbox"], "device": "compat-bob", "owner": "bob"})
        self.assertEqual(self.receive(socket), {"type": "native-discovery-ready", "protocol": 2,
                                               "topics": ["automation-inbox"]})
        socket.send_json({"t": "native-discovery", "protocol": 1, "topics": ["personal-relay"]})
        self.assertEqual(self.receive(socket), {"type": "native-discovery-ready", "protocol": 1})
        self.assertTrue(self.http.portal.call(native_discovery.presence.available, "compat-pc", "alice", 1))
        self.assertFalse(self.http.portal.call(native_discovery.presence.available, "compat-bob", "bob", 1))
        self.assertEqual(self.inbox().json(), {"items": []})

    def test_commit_wakes_only_target_device_and_old_http_claim_state_contract_still_works(self):
        target, sibling, foreign = self.socket(), self.socket("compat-phone"), self.socket("compat-bob")
        self.prepare()
        self.assertEqual(self.receive(target), {"type": "native-discovery", "topic": "automation-inbox"})
        self.quiet(sibling); self.quiet(foreign)
        self.assertEqual(self.inbox().json(), {"items": [{"id": "compat-run", "state": "waiting"}]})
        self.assertEqual(self.inbox("compat-phone").json(), {"items": []})
        self.assertEqual(self.inbox("compat-bob").json(), {"items": []})
        route = "/api/v1/automation-conversations/compat-run"
        denied = self.http.post(route + "/claim", headers=self.headers("compat-phone"), json={"instanceId": "worker"})
        self.assertEqual(denied.status_code, 404)
        claim = self.http.post(route + "/claim", headers=self.headers(), json={"instanceId": "worker"})
        self.assertEqual(claim.status_code, 200, claim.text)
        self.assertEqual(set(claim.json()), {"ok", "input", "trigger", "conversationId", "scheduleId"})
        self.assertEqual(claim.json()["scheduleId"], "compat-plan")
        self.assertEqual(claim.json()["input"]["runId"], "compat-run")
        self.drain(); self.quiet(target)
        for state in ("running", "succeeded"):
            receipt = self.http.post(route + "/state", headers=self.headers(), json={
                "instanceId": "worker", "conversationId": "ordinary-chat", "state": state})
            self.assertEqual(receipt.status_code, 200, receipt.text)
            self.assertEqual(receipt.json(), {"ok": True, "state": state})
            self.drain()
            self.assertEqual(self.receive(target), {"type": "native-discovery", "topic": "automation-inbox"})
            self.quiet(sibling); self.quiet(foreign)
        self.assertEqual(self.inbox().json(), {"items": []})

    def test_rollback_produces_neither_hint_nor_inbox_item_and_next_commit_is_delivered(self):
        socket = self.socket()
        self.prepare("rolled-back", commit=False)
        self.quiet(socket)
        self.assertEqual(self.inbox().json(), {"items": []})
        self.prepare("committed")
        self.assertEqual(self.receive(socket), {"type": "native-discovery", "topic": "automation-inbox"})
        self.assertEqual(self.inbox().json(), {"items": [{"id": "committed", "state": "waiting"}]})

    def test_signed_new_owner_on_same_device_never_receives_old_owner_hint(self):
        self.prepare()
        original = self.socket()
        async def transfer_fixture():
            async with self.sessions() as session:
                client = await session.get(models.Client, "compat-pc")
                client.user_ref = "bob"; client.auth_version += 1
                await session.commit()
                return device_auth.issue_session(client)[0]
        # Deliberately leave the old socket connected to exercise the Hub's
        # owner filter independently of the production revoke/disconnect path.
        replacement_token = self.http.portal.call(transfer_fixture)
        replacement = self.socket(token=replacement_token)
        async def complete_old_occurrence():
            async with self.sessions() as session:
                row = await session.get(models.AiScheduleRun, "compat-run")
                row.state = "failed"
                await session.commit()
            await automation_inbox_events.flush_for_test()
        self.http.portal.call(complete_old_occurrence)
        self.assertEqual(self.receive(original), {"type": "native-discovery", "topic": "automation-inbox"})
        self.quiet(replacement)
        self.assertEqual(self.inbox(token=replacement_token).json(), {"items": []})
        self.assertEqual(self.inbox().status_code, 401, "the prior signed session is really revoked")

    def test_invalid_signature_wrong_device_and_inactive_owner_are_rejected_by_real_auth(self):
        token = self.tokens["compat-pc"]
        forged = token.rsplit(".", 1)[0] + ".invalid-signature"
        self.assertEqual(self.inbox(token=forged).status_code, 401)
        self.assertEqual(self.http.post("/api/v1/automation-conversations/inbox", json={}).status_code, 401)
        for invalid in (forged, self.tokens["compat-bob"]):
            with self.assertRaises(WebSocketDisconnect) as denied:
                self.socket(token=invalid)
            self.assertEqual(denied.exception.code, 4401)
        async def deactivate():
            async with self.sessions() as session:
                owner = await session.get(models.User, "alice")
                owner.is_active = False
                await session.commit()
        self.http.portal.call(deactivate)
        self.assertEqual(self.inbox().status_code, 403)
        with self.assertRaises(WebSocketDisconnect) as denied:
            self.socket()
        self.assertEqual(denied.exception.code, 4401)


if __name__ == "__main__": unittest.main()
