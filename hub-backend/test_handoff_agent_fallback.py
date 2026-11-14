"""Consent/ownership tests with authenticated Hub, real Runner and synthetic CLI."""
import asyncio
import hashlib
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import test_conversation_handoffs as handoff
from fastapi import HTTPException
from app import db
from app.automation_models import RunnerNode
from app.conversation_handoff_models import ConversationHandoff
from app.services import conversation_handoffs as svc, handoff_agent_policy as policy, model_catalog


class FallbackPolicyTests(unittest.TestCase):
    def test_strict_consent_only_allows_source_to_pi(self):
        valid = {"fromAgentId": "codex", "toAgentId": "pi", "accepted": True}
        self.assertEqual(policy.clean_fallback(valid), valid)
        for invalid in (None, {}, {**valid, "accepted": 1}, {**valid, "accepted": False},
                        {**valid, "toAgentId": "qwen"}, {**valid, "fromAgentId": "pi"},
                        {**valid, "fromAgentId": "missing"}, {**valid, "extra": True}):
            with self.subTest(invalid=invalid), self.assertRaises(HTTPException):
                policy.clean_fallback(invalid)
        options = {"agentFallback": valid}
        self.assertEqual(policy.requested_agent({"adapterId": "codex"}, options), "pi")
        for source, agent in (("qwen", "pi"), ("codex", "qwen")):
            with self.assertRaises(HTTPException):
                policy.validate({"adapterId": source}, options, agent)
        with self.assertRaises(HTTPException):
            policy.validate({"adapterId": "codex", "entryKind": "cloud"}, options, "pi")

    def test_runner_kind_rejects_non_string_values(self):
        raw = {"sha256": "a" * 64, "assigneeId": "runner:cloud:codex", "instruction": "Continue"}
        for value in (None, 1, [], {}, "unknown"):
            with self.subTest(value=value), self.assertRaises(HTTPException):
                svc.clean_options({**raw, "targetRunnerKind": value})
        clean = svc.clean_options({**raw, "targetRunnerKind": "work-computer"})
        self.assertEqual(clean["targetRunnerKind"], "work-computer")

    def test_local_model_cannot_enter_a_remote_handoff(self):
        raw = {"sha256": "a" * 64, "assigneeId": "runner:cloud:pi", "instruction": "Continue",
               "model": "local:model-0123456789abcdef0123456789abcdef"}
        with self.assertRaisesRegex(HTTPException, "本地模型不能转交"):
            svc.clean_options(raw)

    def test_legacy_pinned_receipts_remain_usable_but_new_callers_cannot_forge_them(self):
        source = {"adapterId": "pi"}
        with self.assertRaises(HTTPException):
            policy.validate(source, {}, "codex")
        self.assertFalse(policy.validate(source, {"targetSnapshot": {"agentId": "codex"}}, "codex"))
        raw = {"sha256": "a" * 64, "assigneeId": "runner:cloud:codex", "instruction": "Continue"}
        clean = svc.clean_options(raw)
        self.assertNotIn("agentFallback", clean, "Do not change legacy request hashes")
        with self.assertRaises(HTTPException):
            svc.clean_options({**raw, "targetSnapshot": {"agentId": "codex"}})


class HandoffFallbackTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fx = handoff.HandoffTests("test_security_two_phase_real_execution_and_restart")
        await self.fx.asyncSetUp()
        self.http, self.runner = self.fx.http, self.fx.runner
        self.model_requests = []

        async def resolve(_session, _client, name=""):
            self.model_requests.append(name)
            if name and name != "managed-choice":
                raise ValueError("Requested model is unavailable")
            return {"base": "http://127.0.0.1:1/v1", "key": "fixture-only",
                    "model": name or "managed-default"}
        self.models = patch.object(model_catalog, "resolve", resolve)
        self.models.start()

    async def asyncTearDown(self):
        self.models.stop()
        await self.fx.asyncTearDown()

    def agents(self, *names):
        self.runner.agents = [{"key": name, "name": name, "auth": "authed"} for name in names]

    async def prepare(self, transfer, source="codex", **options):
        return await self.fx.prepare(transfer, snapshot=handoff.archive(agent=source, model="native-private-model"),
            **{"assigneeId": "", "agentId": "pi", "model": "", "instruction": "Continue the report",
               "agentFallback": {"fromAgentId": source, "toAgentId": "pi", "accepted": True}, **options})

    async def test_consent_same_agent_priority_fences_model_default_and_real_execution(self):
        self.agents("pi", "codex")
        for suffix in ("", "?agentId=pi", "?agentId=opencode"):
            catalog = await self.http.get("/api/v1/conversation-handoffs/targets" + suffix)
            self.assertEqual(catalog.status_code, 200, catalog.text)
            self.assertEqual(catalog.json()["handoffCapabilities"], {"piFallback": True})
        preferred = await self.fx.prepare("same-agent", assigneeId="", agentId="codex")
        self.assertEqual(preferred.status_code, 200, preferred.text)
        self.assertEqual(preferred.json()["target"]["agentId"], "codex")
        self.assertEqual((await self.prepare("still-has-same")).status_code, 409)
        self.assertEqual((await self.prepare("explicit-still-has-same", assigneeId="runner:cloud:pi")).status_code, 409)
        for target, origin in (("pi", "codex"), ("codex", "pi")):
            denied = await self.fx.prepare("no-consent-" + origin,
                snapshot=handoff.archive(agent=origin), assigneeId="runner:cloud:" + target)
            self.assertEqual(denied.status_code, 409, denied.text)
        self.agents("pi")
        missing = await self.fx.prepare("no-silent-fallback", assigneeId="", agentId="codex")
        self.assertEqual(missing.status_code, 409)
        mismatch = await self.prepare("source-mismatch", source="qwen",
            agentFallback={"fromAgentId": "codex", "toAgentId": "pi", "accepted": True})
        self.assertEqual(mismatch.status_code, 409)
        inherited = await self.prepare("do-not-use-account-model", model="native-private-model")
        self.assertEqual(inherited.status_code, 409)
        denied_skill = await self.prepare("missing-skill", requiredSkills=["unavailable-skill"])
        self.assertEqual(denied_skill.status_code, 409)
        self.runner.caps = []
        self.assertEqual((await self.prepare("old-runner")).status_code, 409)
        self.runner.caps = ["handoff1"]
        self.runner.client_id = self.fx.client.id
        self.assertEqual((await self.prepare("current-device")).status_code, 409)
        self.runner.client_id = ""
        async with db.SessionLocal() as session:
            node = await session.get(RunnerNode, "cloud")
            node.owner_user_id = "other"
            await session.commit()
        self.assertEqual((await self.prepare("foreign-node")).status_code, 409)
        async with db.SessionLocal() as session:
            node = await session.get(RunnerNode, "cloud")
            node.owner_user_id = self.fx.owner.id
            await session.commit()
        # An aborted attempt stays fenced even when a valid fallback arrives late.
        await self.http.post("/api/v1/conversation-handoffs/aborted/abort")
        self.assertEqual((await self.prepare("aborted")).json()["phase"], "aborted")
        self.assertNotIn("job.dispatch", self.fx.peer.calls)

        for origin in ("codex", "opencode"):
            with self.subTest(source=origin):
                self.agents("pi")
                self.model_requests.clear()
                transfer = "fallback-" + origin
                prepared = await self.prepare(transfer, source=origin)
                self.assertEqual(prepared.status_code, 200, prepared.text)
                receipt = prepared.json()
                self.assertEqual(receipt["target"]["agentId"], "pi")
                self.assertEqual(receipt["source"]["adapterId"], origin)
                self.assertEqual(receipt["agentFallback"],
                    {"fromAgentId": origin, "toAgentId": "pi", "accepted": True})
                repeated = await self.prepare(transfer, source=origin)
                self.assertEqual(repeated.json()["taskId"], receipt["taskId"])
                # Accepted confirmation and destination are part of the frozen request.
                changed = await self.fx.prepare(transfer, snapshot=handoff.archive(agent=origin, model="native-private-model"),
                    assigneeId="", agentId="pi", model="", instruction="Continue the report")
                self.assertEqual(changed.status_code, 409)
                async with db.SessionLocal() as session:
                    row = await session.get(ConversationHandoff, svc.identity(self.fx.client.id, transfer))
                    self.assertEqual(row.options["model"], "")
                    requested = svc.clean_options({"sha256": receipt["sha256"], "assigneeId": "", "agentId": "pi",
                        "model": "", "instruction": "Continue the report", "agentFallback": receipt["agentFallback"]})
                    self.assertEqual(row.request_hash, hashlib.sha256(json.dumps(requested, sort_keys=True,
                        ensure_ascii=False, separators=(",", ":")).encode()).hexdigest())
                # A same-Agent destination appearing after preparation does not repin
                # an already consented, durable Pi transfer or create a second run.
                self.agents("pi", origin)
                committed = await self.http.post(f"/api/v1/conversation-handoffs/{transfer}/commit",
                    json={"sha256": receipt["sha256"]})
                self.assertEqual(committed.status_code, 200, committed.text)
                self.assertEqual(committed.json()["phase"], "committed", committed.text)
                ref = committed.json()["ref"]
                result = await self.fx.complete(ref)
                self.assertEqual(result["cli"], "pi")
                self.assertEqual(result["model"], "managed-default")
                self.assertNotIn("native-private-model", self.model_requests)
                info = await asyncio.to_thread(self.fx.peer.call, self.runner, "job.info", {"ref": ref})
                workspace = Path(info["data"]["workDir"])
                self.assertTrue((workspace / "delivery.md").is_file())
                self.assertEqual((workspace / "input.txt").read_text(encoding="utf-8"), "portable input")
                prompts = [json.loads(line) for line in (workspace / ".cache/prompts.jsonl").read_text(encoding="utf-8").splitlines()]
                self.assertEqual(len(prompts), 1)
                self.assertIn("Keep the report title unchanged.", prompts[0]["prompt"])
                repeated = await self.prepare(transfer, source=origin)
                self.assertEqual(repeated.json()["ref"], ref)
                if origin == "opencode":
                    self.runner.caps.append("executionSelection1")
                    url = f"/api/v1/tasks/{receipt['taskId']}/ai-say"
                    switched = await self.http.post(url, json={"text": "Continue on OpenCode",
                        "messageId": "switch-after-fallback", "executionSelection": {
                            "agentId": "opencode", "modelName": "managed-choice"}})
                    self.assertEqual(switched.status_code, 200, switched.text)
                    self.assertTrue(switched.json().get("ok"), switched.text)
                    self.assertEqual((await self.fx.complete(ref))["cli"], "opencode")
                    followup = await self.http.post(url, json={"text": "Keep the results",
                        "messageId": "continue-after-fallback"})
                    self.assertTrue(followup.json().get("ok"), followup.text)
                    self.assertEqual((await self.fx.complete(ref))["model"], "managed-choice")
                    # Retrying the original handoff still matches its initial
                    # consent hash after a separately authorized cloud switch.
                    repeated = await self.prepare(transfer, source=origin)
                    self.assertEqual(repeated.json()["ref"], ref)
                    self.assertEqual(repeated.json()["target"]["agentId"], "opencode")
                    self.assertEqual(repeated.json()["agentFallback"], receipt["agentFallback"])
        self.assertEqual(self.fx.peer.calls.count("job.dispatch"), 2)


if __name__ == "__main__":
    unittest.main()
