"""Real ASGI auth, isolated DB and loopback model HTTP; no external inference."""
import asyncio
import base64
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from sqlalchemy import select

from test_model_runtime import IsolatedDatabase
from app import auth
from app.db import get_session
from app.models import AuditLog, Client, ModelDef, ModelProvider, User
from app.api import model_capabilities as api, tasks, ai_proxy
from app.services import model_capabilities as caps, model_capability_probe as probe, model_catalog as catalog
from app.services import device_auth, model_config_guard, runtime_images, ai_exec, local_base


class CapabilityTests(IsolatedDatabase):
    async def test_admin_model_edit_persists_capabilities_and_rejects_conflicting_limits(self):
        from app.api import admin
        self.app.include_router(admin.router)
        async with self.sessions() as session:
            revision = model_config_guard.revision(await session.get(ModelDef, "p:model"))
        config = {"imageRouting": "auto", "maxOutputTokens": 32000,
                  "capabilities": {"imageInput": "supported", "streaming": "unknown", "toolCalling": "supported"},
                  "thinkingMode": "controllable", "thinkingFormat": "openai"}
        body = {"providerId": "p", "name": "model", "ctxWindow": 128000, "config": config,
                "expectedRevision": revision}
        with patch.object(admin.audit, "log", new=AsyncMock()):
            response = await self.http.put("/api/v1/admin/model-defs", headers=self.headers["admin"], json=body)
        self.assertEqual(response.status_code, 200, response.text)
        async with self.sessions() as session:
            saved = await session.get(ModelDef, "p:model")
            self.assertEqual(saved.ctx_window, 128000)
            self.assertEqual(saved.config["maxOutputTokens"], 32000)
            self.assertEqual(saved.config["capabilities"], config["capabilities"])
            body["expectedRevision"] = model_config_guard.revision(saved)
        for context in (8192, True, 2.5, 10000001):
            response = await self.http.put("/api/v1/admin/model-defs", headers=self.headers["admin"],
                                           json={**body, "ctxWindow": context})
            self.assertEqual(response.status_code, 400, response.text)
        async with self.sessions() as session:
            self.assertEqual((await session.get(ModelDef, "p:model")).ctx_window, 128000)

    async def asyncSetUp(self):
        await super().asyncSetUp()
        self.requests, self.mode, self.peers = [], "ok", []
        self.challenge = ""
        self.server = await asyncio.start_server(self.serve, "127.0.0.1", 0)
        self.base = "http://127.0.0.1:" + str(self.server.sockets[0].getsockname()[1]) + "/v1"
        async with self.engine.begin() as connection:
            await connection.run_sync(User.__table__.create)
            await connection.run_sync(AuditLog.__table__.create)
        async with self.sessions() as session, session.begin():
            session.add_all([
                User(id="admin", username="admin", is_super=True),
                User(id="alice", username="alice"), User(id="bob", username="bob"),
                Client(id="a", user_ref="alice", auth_state="active", model_keys={"p": "alice-private"}),
                Client(id="b", user_ref="bob", auth_state="active", model_keys={"p": "bob-private"}),
                ModelProvider(id="p", name="Fixture", api_key="company-private", base_url=self.base),
                ModelDef(id="p:model", provider_id="p", name="model", ctx_window=128000,
                         config={"imageRouting": "auto", "maxOutputTokens": 32768}),
            ])
        self.app = FastAPI()
        self.app.include_router(api.router)
        self.app.include_router(tasks.router)
        self.app.include_router(ai_proxy.router)
        async def isolated_session():
            async with self.sessions() as session:
                yield session
        self.app.dependency_overrides[get_session] = isolated_session
        self.http = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url="http://test")
        self.headers = {"admin": {"Authorization": "Bearer " + auth.sign_claims(
            {"uid": "admin", "ver": 1}, ttl_seconds=600, token_type="user")}}
        async with self.sessions() as session:
            for name in ("a", "b"):
                token, _ = device_auth.issue_session(await session.get(Client, name))
                self.headers[name] = {"Authorization": "Device " + token}
        original = probe.image_challenge
        def challenge():
            expected, image = original()
            self.challenge = expected
            return expected, image
        self.challenge_patch = patch.object(probe, "image_challenge", side_effect=challenge)
        self.challenge_patch.start()

    async def asyncTearDown(self):
        self.challenge_patch.stop()
        await self.http.aclose()
        self.server.close()
        await self.server.wait_closed()
        await asyncio.gather(*self.peers, return_exceptions=True)
        await super().asyncTearDown()

    async def serve(self, reader, writer):
        self.peers.append(asyncio.current_task())
        try:
            headers = await reader.readuntil(b"\r\n\r\n")
            length = next(int(row.split(b":")[1]) for row in headers.lower().split(b"\r\n")
                          if row.startswith(b"content-length:"))
            body = json.loads(await reader.readexactly(length))
            self.requests.append((headers.decode(), body))
            status, content_type = "200 OK", "application/json"
            if self.mode == "timeout":
                await reader.read()
                return
            if self.mode == "unsupported":
                status, data = "400 Bad Request", b'{"error":{"message":"image input is not supported"}}'
            elif self.mode == "private-error":
                status, data = "401 Unauthorized", b'{"error":{"message":"company-private secret internal response"}}'
            elif body.get("stream"):
                content_type = "text/event-stream"
                data = (b'data: {"choices":[{"delta":{"reasoning_content":"test thought"}}]}\n\n'
                        b'data: {"choices":[{"delta":{"content":"OK"}}]}\n\ndata: [DONE]\n\n')
            else:
                message = {"content": "OK"}
                if body.get("tools"):
                    value = re.search(r"value ([a-f0-9]+)", body["messages"][0]["content"])[1]
                    message = {"tool_calls": [{"id": "call-test", "type": "function", "function": {
                        "name": "soduwork_capability_echo", "arguments": json.dumps({"value": value})}}]}
                elif isinstance(body["messages"][0]["content"], list):
                    url = body["messages"][0]["content"][1]["image_url"]["url"]
                    self.assertEqual(runtime_images._mime(base64.b64decode(url.split(",")[1])), "image/png")
                    self.assertNotIn(self.challenge, body["messages"][0]["content"][0]["text"])
                    message = {"content": self.challenge if self.mode != "wrong-image" else "000000"}
                data = json.dumps({"choices": [{"message": message}]}).encode()
            writer.write(("HTTP/1.1 " + status + "\r\nContent-Type: " + content_type +
                          "\r\nContent-Length: " + str(len(data)) + "\r\nConnection: close\r\n\r\n").encode() + data)
            await writer.drain()
        finally:
            writer.close()
            await writer.wait_closed()

    async def check(self, who="a", checks=None, **extra):
        path = "/api/v1/admin/model-capabilities/check" if who == "admin" else "/api/v1/my-models/capabilities/check"
        return await self.http.post(path, headers=self.headers.get(who, {}), json={
            "providerId": "p", "model": "model", "checks": checks or list(probe.CHECKS), **extra})

    async def test_real_checks_persist_and_propagate_to_runtime_with_scoped_evidence(self):
        response = await self.check()
        self.assertEqual(response.status_code, 200, response.text)
        result = response.json()
        self.assertTrue(result["ok"], result)
        self.assertEqual(len(self.requests), 4)
        self.assertTrue(all("Bearer alice-private" in headers for headers, _ in self.requests))
        self.assertEqual(result["capabilityProfile"]["imageInput"]["source"], "verified")
        self.assertEqual(result["capabilityProfile"]["reasoningStream"]["state"], "reported")
        self.assertEqual(result["imageRouting"], "native")
        self.assertNotIn("alice-private", response.text)
        mine = await self.http.get("/api/v1/my-models", headers=self.headers["a"])
        self.assertTrue(mine.json()["usable"][0]["capabilityCheck"]["checkedAt"])
        config = await self.http.get("/api/v1/ai-proxy/config", headers=self.headers["a"])
        self.assertEqual(config.json()["input"], ["text", "image"])
        self.assertEqual(config.json()["maxOutputTokens"], 32768)
        async with self.sessions() as session:
            admin = (await catalog.catalog(session))["models"][0]
            bob = (await catalog.usable(session, await session.get(Client, "b")))[0]
            self.assertIsNone(admin["capabilityCheck"])
            self.assertIsNone(bob["capabilityCheck"])
            self.assertEqual(bob["imageRouting"], "vision-fallback")
            alice = await catalog.resolve(session, await session.get(Client, "a"))
            llm = ai_exec.with_llm({"cfg": {"llm": {}}}, alice)["cfg"]["llm"]
            self.assertEqual(llm["maxOutputTokens"], 32768)
            self.assertEqual(llm["capabilityProfile"]["streaming"]["state"], "supported")
        company = await self.check("admin", ["connection"])
        self.assertEqual(company.status_code, 200)
        self.assertIn("Bearer company-private", self.requests[-1][0])
        async with self.sessions() as session:
            events = list((await session.scalars(select(AuditLog))).all())
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].actor_id, "admin")
            self.assertEqual(events[0].action, "model.capability_check")
            self.assertEqual(events[0].target_id, "p:model")
            self.assertEqual(events[0].detail, {"checks": {"connection": "passed"}})

    async def test_auth_saved_scope_and_no_arbitrary_endpoint(self):
        self.assertEqual((await self.check("missing")).status_code, 401)
        self.assertEqual((await self.check(baseUrl="https://attacker.invalid")).status_code, 400)
        self.assertEqual((await self.check(model="not-saved")).status_code, 404)
        self.assertEqual((await self.check(providerId="other")).status_code, 404)
        no_permission = auth.sign_claims({"uid": "alice", "ver": 1}, ttl_seconds=600, token_type="user")
        response = await self.http.post("/api/v1/admin/model-capabilities/check", headers={"Authorization": "Bearer " + no_permission}, json={})
        self.assertEqual(response.status_code, 403)
        self.assertEqual(self.requests, [])

    async def test_organization_evidence_follows_org_credentials_and_runtime_revision_changes(self):
        async with self.sessions() as session:
            client = await session.get(Client, "b")
            client.model_keys = {}
            client.models = [{"providerId": "p", "name": "personal-alias", "config": {"imageRouting": "auto"}}]
            await session.commit()
        before = (await self.http.get("/api/v1/ai-proxy/config", headers=self.headers["b"])).json()
        result = await self.check("admin", ["imageInput"])
        self.assertEqual(result.status_code, 200)
        after = (await self.http.get("/api/v1/ai-proxy/config", headers=self.headers["b"])).json()
        self.assertEqual(after["imageRouting"], "native")
        self.assertEqual(after["capabilityProfile"]["imageInput"]["source"], "verified")
        self.assertEqual(before["configRevision"], after["configRevision"])
        self.assertNotEqual(before["runtimeRevision"], after["runtimeRevision"])
        alice = (await self.http.get("/api/v1/ai-proxy/config", headers=self.headers["a"])).json()
        self.assertEqual(alice["imageRouting"], "vision-fallback")
        mine = (await self.http.get("/api/v1/my-models", headers=self.headers["b"])).json()
        own = next(row for row in mine["usable"] if row["own"])
        self.assertIsNone(own["capabilityCheck"])
        self.assertEqual(own["imageRouting"], "vision-fallback")

    async def test_key_address_model_config_changes_invalidate_evidence(self):
        self.assertTrue((await self.check(checks=["connection", "imageInput"])).json()["ok"])
        async with self.sessions() as session:
            client = await session.get(Client, "a")
            model = await session.get(ModelDef, "p:model")
            p = (await catalog.effective_provider_map(session, client))["p"]
            row = catalog._m_api(model)
            scope = "client:a"
            _, before = caps.identity(row, p, "alice-private", scope)
            variants = [(row, {**p, "baseUrl": p["baseUrl"] + "/new"}, "alice-private"),
                        ({**row, "name": "other"}, p, "alice-private"),
                        ({**row, "config": {"imageRouting": "native"}}, p, "alice-private"),
                        (row, p, "changed-key")]
            for changed, provider, key in variants:
                self.assertNotEqual(caps.identity(changed, provider, key, scope)[1], before)
            client.model_keys = {"p": "new-private"}
            await session.commit()
        async with self.sessions() as session:
            row = (await catalog.usable(session, await session.get(Client, "a")))[0]
            self.assertIsNone(row["capabilityCheck"])
            self.assertEqual(row["capabilityProfile"]["imageInput"]["state"], "unknown")

    async def test_timeout_unsupported_and_bad_answer_have_distinct_truthful_results(self):
        self.mode = "timeout"
        with patch.object(probe, "TIMEOUT", .15):
            result = (await self.check(checks=["imageInput"])).json()
        self.assertEqual(result["checks"]["imageInput"]["status"], "inconclusive")
        self.assertEqual(result["capabilityProfile"]["imageInput"]["state"], "unknown")
        self.mode = "wrong-image"
        result = (await self.check(checks=["imageInput"])).json()
        self.assertEqual(result["checks"]["imageInput"]["code"], "expected_output_missing")
        self.mode = "unsupported"
        result = (await self.check(checks=["imageInput"])).json()
        self.assertEqual(result["checks"]["imageInput"]["status"], "unsupported")
        self.mode = "private-error"
        response = await self.check(checks=["connection"])
        self.assertNotIn("company-private", response.text)
        self.assertNotIn("internal response", response.text)
        self.assertEqual(response.json()["checks"]["connection"]["code"], "credentials_or_access")

    async def test_model_edit_during_probe_discards_stale_result(self):
        original = probe.run
        async def changed(conf, checks):
            result = await original(conf, checks)
            async with self.sessions() as session:
                model = await session.get(ModelDef, "p:model")
                model.config = {"imageRouting": "auto", "maxOutputTokens": 4096}
                await session.commit()
            return result
        with patch.object(probe, "run", side_effect=changed):
            result = await self.check(checks=["connection"])
        self.assertEqual(result.status_code, 409)

    async def test_personal_model_config_roundtrip_preserves_limits_and_declarations(self):
        async with self.sessions() as session:
            client = await session.get(Client, "a")
            revision = model_config_guard.revision(client)
        config = {"imageRouting": "auto", "maxOutputTokens": 8192,
                  "capabilities": {"imageInput": "supported", "toolCalling": "unknown", "streaming": "supported"}}
        response = await self.http.put("/api/v1/my-models", headers=self.headers["a"], json={
            "expectedRevision": revision, "models": [{"providerId": "p", "name": "own",
                "ctxWindow": 64000, "config": config}]})
        self.assertEqual(response.status_code, 200, response.text)
        own = next(row for row in response.json()["usable"] if row["name"] == "own")
        self.assertEqual(own["config"], config)
        self.assertEqual(own["ctxWindow"], 64000)
        self.assertEqual(own["imageRouting"], "native")
        self.assertEqual(own["capabilityProfile"]["imageInput"]["source"], "configured")
        response = await self.check(model="own", checks=["connection", "streaming"])
        self.assertEqual(response.status_code, 200)
        mine = (await self.http.get("/api/v1/my-models", headers=self.headers["a"])).json()
        self.assertIsNotNone(mine["myModels"][0]["capabilityCheck"])


    async def test_resolved_model_reports_optional_adapter_without_selecting_it(self):
        async with self.sessions() as session:
            client = await session.get(Client, "a")
            for enabled in (False, True):
                with patch.object(catalog, "adapter_configured", return_value=enabled):
                    resolved = await catalog.resolve(session, client, "model")
                self.assertEqual(resolved["model"], "model")
                self.assertIs(resolved["visionFallbackAvailable"], enabled)
                carried = ai_exec.with_llm({"cfg": {"llm": {"visionFallbackAvailable": not enabled}}}, resolved)["cfg"]["llm"]
                self.assertIs(carried["visionFallbackAvailable"], enabled)


class ContractTests(unittest.TestCase):
    def test_limits_reject_invalid_and_conflicting_values(self):
        for value in (True, 1.5, "1.5", -1, 10000001):
            with self.assertRaises(ValueError):
                caps.validate_limits(value, {})
        self.assertEqual(caps.validate_limits(None, {}), 0)
        self.assertEqual(caps.validate_limits("128000", {"maxOutputTokens": 32000}), 128000)
        with self.assertRaises(ValueError):
            caps.validate_limits(8000, {"maxOutputTokens": 32000})

    def test_runner_native_configs_preserve_selected_model_limits(self):
        llm = {"base": "https://fixture.invalid/v1", "key": "private-key", "model": "fixture",
               "contextWindow": 128000, "maxOutputTokens": 32768, "imageRouting": "native"}
        env = local_base._env_for(local_base._PROFILES["opencode"], {"llm": llm})
        definition = json.loads(env["OPENCODE_CONFIG_CONTENT"])["provider"]["company"]["models"]["fixture"]
        self.assertEqual(definition["limit"], {"context": 128000, "output": 32768})
        self.assertEqual(definition["modalities"]["input"], ["text", "image"])
        with tempfile.TemporaryDirectory(prefix="soduwork-pi-config-") as folder:
            with patch.object(local_base, "_data_root", return_value=folder):
                env = local_base._env_for(local_base._PROFILES["pi"], {"llm": llm}, "model-capabilities")
            content = (Path(env["PI_CODING_AGENT_DIR"]) / "models.json").read_text(encoding="utf-8")
            definition = json.loads(content)["providers"]["company"]["models"][0]
            self.assertEqual(definition["maxTokens"], 32768)
            self.assertEqual(definition["input"], ["text", "image"])
            self.assertNotIn("private-key", content)

    def test_legacy_unknown_and_explicit_native_are_not_claimed_verified(self):
        self.assertEqual(caps.runtime_fields({})["imageRouting"], "vision-fallback")
        self.assertEqual(caps.profile({})["toolCalling"]["state"], "unknown")
        self.assertEqual(caps.profile({"imageRouting": "native"})["imageInput"]["source"], "legacy-native")
        for config in ({"capabilities": {"imageInput": True}}, {"maxOutputTokens": True},
                       {"maxOutputTokens": 1023}, {"maxOutputTokens": 262145},
                       {"imageRouting": "native", "capabilities": {"imageInput": "unsupported"}}):
            with self.assertRaises(ValueError):
                catalog.clean_model_config(config)
        self.assertEqual(catalog.clean_model_config({"imageRouting": "auto"}), {"imageRouting": "auto"})

    def test_declared_native_support_is_used_for_automatic_routing(self):
        for route in (None, "auto", "native"):
            fields = caps.runtime_fields({"imageRouting": route, "capabilities": {"imageInput": "supported"}})
            self.assertEqual(fields["imageRouting"], "native")
            self.assertEqual(fields["capabilityProfile"]["imageInput"]["source"], "configured")
        self.assertEqual(caps.runtime_fields({"capabilities": {"imageInput": "unsupported"}})["imageRouting"], "vision-fallback")

    def test_explicit_adapter_route_is_preserved_for_a_native_capable_model(self):
        for capabilities, evidence in (({"imageInput": "supported"}, None),
                ({}, {"checks": {"imageInput": {"status": "passed"}}})):
            fields = caps.runtime_fields({"imageRouting": "vision-fallback", "capabilities": capabilities}, evidence)
            self.assertEqual(fields["capabilityProfile"]["imageInput"]["state"], "supported")
            self.assertEqual(fields["imageRouting"], "vision-fallback")

if __name__ == "__main__":
    unittest.main()
