"""Probe routing keeps native accounts separate from managed model credentials."""
import os
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

os.environ.setdefault("DATABASE_URL", "sqlite+aiosqlite:///:memory:")
os.environ.setdefault("AUTH_SECRET", "isolated-agent-probe-route-fixture")
os.environ.setdefault("ADMIN_PASS", "isolated-agent-probe-route-fixture")
from fastapi import HTTPException
from app.api import agents


class AgentProbeRouteTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.owner = SimpleNamespace(id="fixture-client", user_ref="fixture-owner")
        self.session = object()
        self.managed = {"base": "https://fixture.invalid/v1", "key": "fixture-key",
                        "model": "glm-fixture", "keyFrom": "mine", "fellBackFrom": "removed"}

    async def test_native_backend_probe_omits_managed_credentials_and_model_claims(self):
        with (patch.object(agents.bus, "enabled", False),
              patch.object(agents.runner_hub, "for_client", return_value=None),
              patch.object(agents.model_catalog, "resolve_for_agent",
                           new=AsyncMock(return_value=self.managed)) as resolve,
              patch.object(agents.agent_setup, "start_probe", return_value="native-job") as start):
            result = await agents.post_agent_probe({"key": "codex", "model": "managed-override"},
                                                   self.owner, self.session)
        self.assertEqual(result, {"jobId": "native-job", "model": "",
                                  "fellBackFrom": "", "keyFrom": ""})
        start.assert_called_once_with("codex", {})
        resolve.assert_not_awaited()

    async def test_native_probe_targets_owned_runner_without_managed_model(self):
        runner = SimpleNamespace(id="fixture-runner", client_id=self.owner.id)
        with (patch.object(agents.runner_hub, "get", return_value=runner),
              patch.object(agents.model_catalog, "resolve_for_agent",
                           new=AsyncMock(return_value=self.managed)) as resolve,
              patch.object(agents, "_runner_call", new=AsyncMock(return_value={"jobId": "native-job"})) as rpc,
              patch.object(agents.agent_setup, "start_probe") as local):
            result = await agents.post_agent_probe({"key": "codex", "runnerId": runner.id},
                                                   self.owner, self.session)
        self.assertEqual(result, {"jobId": "runner|fixture-runner|native-job", "model": "",
                                  "fellBackFrom": "", "keyFrom": ""})
        rpc.assert_awaited_once_with(runner, "agent.probe", {"key": "codex", "llm": {}}, timeout=60)
        resolve.assert_not_awaited()
        local.assert_not_called()

    async def test_native_probe_accepts_personal_cloud_runner_of_same_account(self):
        runner = SimpleNamespace(id="cloud-runner", client_id="", owner_user_id=self.owner.user_ref)
        with (patch.object(agents.runner_hub, "get", return_value=runner),
              patch.object(agents.model_catalog, "resolve_for_agent",
                           new=AsyncMock(return_value=self.managed)) as resolve,
              patch.object(agents, "_runner_call", new=AsyncMock(return_value={"jobId": "cloud-job"})) as rpc):
            result = await agents.post_agent_probe({"key": "codex", "runnerId": runner.id},
                                                   self.owner, self.session)
        self.assertEqual(result["jobId"], "runner|cloud-runner|cloud-job")
        self.assertEqual(result["model"], "")
        rpc.assert_awaited_once_with(runner, "agent.probe", {"key": "codex", "llm": {}}, timeout=60)
        resolve.assert_not_awaited()

    async def test_managed_probes_keep_model_resolution_and_selected_execution_machine(self):
        for key in ("pi", "codex-harness"):
            for remote in (False, True):
                runner = SimpleNamespace(id="fixture-runner", client_id=self.owner.id) if remote else None
                with (self.subTest(key=key, remote=remote),
                      patch.object(agents.bus, "enabled", False),
                      patch.object(agents.runner_hub, "for_client", return_value=None),
                      patch.object(agents.runner_hub, "get", return_value=runner),
                      patch.object(agents.model_catalog, "resolve_for_agent",
                                   new=AsyncMock(return_value=self.managed)) as resolve,
                      patch.object(agents, "_runner_call", new=AsyncMock(return_value={"jobId": "managed-job"})) as rpc,
                      patch.object(agents.agent_setup, "start_probe", return_value="managed-job") as local):
                    result = await agents.post_agent_probe({"key": key, "model": "chosen",
                        "runnerId": "fixture-runner" if remote else ""}, self.owner, self.session)
                    self.assertEqual(result, {"jobId": "runner|fixture-runner|managed-job" if remote else "managed-job",
                        "model": "glm-fixture", "fellBackFrom": "removed", "keyFrom": "mine"})
                    resolve.assert_awaited_once_with(self.session, self.owner, key, "chosen")
                    if remote:
                        rpc.assert_awaited_once_with(runner, "agent.probe", {"key": key, "llm": self.managed}, timeout=60)
                        local.assert_not_called()
                    else:
                        local.assert_called_once_with(key, self.managed)
                        rpc.assert_not_awaited()

    async def test_native_probe_rejects_other_owners_runner_without_starting_work(self):
        for runner in (SimpleNamespace(id="foreign-runner", client_id="other-client"),
                       SimpleNamespace(id="foreign-runner", client_id="", owner_user_id="other-owner")):
            with (self.subTest(runner=runner),
                  patch.object(agents.runner_hub, "get", return_value=runner),
                  patch.object(agents.model_catalog, "resolve_for_agent", new=AsyncMock(return_value=self.managed)),
                  patch.object(agents, "_runner_call", new=AsyncMock()) as rpc,
                  patch.object(agents.agent_setup, "start_probe") as local):
                with self.assertRaises(HTTPException) as raised:
                    await agents.post_agent_probe({"key": "codex", "runnerId": runner.id},
                                                  self.owner, self.session)
                self.assertEqual(raised.exception.status_code, 404)
                rpc.assert_not_awaited()
                local.assert_not_called()

    async def test_device_local_model_availability_is_not_advertised_to_remote_machines(self):
        from app.services import execution_aliases
        local = SimpleNamespace(id="desktop", client_id=self.owner.id, host="Desktop",
                                connected_at=1, os="macos", owner_name="Owner")
        remote = SimpleNamespace(id="remote", client_id="other-device", host="Remote",
                                 connected_at=2, os="linux", owner_name="Owner")
        with (patch.object(execution_aliases, "load", new=AsyncMock(return_value={})),
              patch.object(agents.runner_hub, "online", return_value=[local, remote]),
              patch.object(agents, "scope_for", return_value="mine"),
              patch.object(agents.runner_hub, "is_client_runtime", return_value=True),
              patch.object(agents, "_runner_call", new=AsyncMock(return_value={"agents": []})) as rpc):
            await agents._machines(self.session, self.owner, False, has_local_model=True)
        self.assertEqual(rpc.await_args_list[0].args, (local, "agent.setup", {"hasModel": True}))
        self.assertEqual(rpc.await_args_list[1].args, (remote, "agent.setup", {"hasModel": False}))

    async def test_account_agent_defaults_reject_hub_models_before_catalog_access(self):
        for key in ("codex", "claude"):
            session = SimpleNamespace(commit=AsyncMock())
            with (self.subTest(key=key), patch.object(agents.model_catalog, "usable", new=AsyncMock()) as usable):
                with self.assertRaises(HTTPException) as raised:
                    await agents.put_agent_model({"key": key, "model": "hub-model"}, self.owner, session)
                self.assertEqual(raised.exception.status_code, 422)
                usable.assert_not_awaited()
                session.commit.assert_not_awaited()

    async def test_account_agent_defaults_can_clear_a_legacy_mismatch_without_changing_managed_defaults(self):
        from app.services import client_domain_events
        for key in ("codex", "claude"):
            self.owner.agent_models = {key: "legacy-hub-model", "qwen": "hub-model"}
            session = SimpleNamespace(commit=AsyncMock())
            with (self.subTest(key=key),
                  patch.object(agents.model_catalog, "usable", new=AsyncMock()) as usable,
                  patch.object(client_domain_events, "device_changed", new=AsyncMock()) as changed):
                result = await agents.put_agent_model({"key": key, "model": ""}, self.owner, session)
                self.assertEqual(result["model"], "")
                self.assertEqual(self.owner.agent_models, {"qwen": "hub-model"})
                usable.assert_not_awaited()
                session.commit.assert_awaited_once()
                changed.assert_awaited_once_with(self.owner, "models")

    async def test_all_managed_agent_defaults_accept_available_hub_models(self):
        from app.services import client_domain_events
        for key in ("pi", "qwen", "opencode", "dsh", "kimi", "harness2", "codex-harness"):
            self.owner.agent_models = {}
            session = SimpleNamespace(commit=AsyncMock())
            with (self.subTest(key=key),
                  patch.object(agents.model_catalog, "usable", new=AsyncMock(return_value=[{"name": "hub-model"}])) as usable,
                  patch.object(client_domain_events, "device_changed", new=AsyncMock())):
                result = await agents.put_agent_model({"key": key, "model": "hub-model"}, self.owner, session)
                self.assertEqual(result["model"], "hub-model")
                self.assertEqual(self.owner.agent_models, {key: "hub-model"})
                usable.assert_awaited_once_with(session, self.owner)
                session.commit.assert_awaited_once()

    async def test_account_agent_setup_never_projects_hub_models_or_legacy_overrides(self):
        self.owner.agent_models = {"codex": "missing-model", "claude": "hub-model", "qwen": "hub-model"}
        machines = [{"env": {}, "execution": "runner", "agents": [
            {"key": "codex", "needsLlm": False}, {"key": "claude", "needsLlm": False},
            {"key": "qwen", "needsLlm": True},
        ]}]
        with (patch.object(agents.model_catalog, "usable", new=AsyncMock(return_value=[{"name": "hub-model"}])),
              patch.object(agents, "_machines", new=AsyncMock(return_value=machines))):
            result = await agents.get_agent_setup(self.owner, self.session, None, False)
        for row in result["agents"][:2]:
            self.assertFalse(row["modelPick"])
            self.assertEqual(row["model"], "")
            self.assertEqual(row["modelEffective"], "")
            self.assertFalse(row["modelGone"])
        self.assertTrue(result["agents"][2]["modelPick"])
        self.assertEqual(result["agents"][2]["modelEffective"], "hub-model")

    async def test_account_agent_configure_does_not_resolve_or_forward_hub_credentials(self):
        for key in ("codex", "claude"):
            runner = SimpleNamespace(id="fixture-runner", client_id=self.owner.id)
            with (self.subTest(key=key),
                  patch.object(agents.runner_hub, "get", return_value=runner),
                  patch.object(agents.model_catalog, "resolve_for_agent", new=AsyncMock(return_value=self.managed)) as resolve,
                  patch.object(agents, "_runner_call", new=AsyncMock(return_value={"ok": True})) as rpc):
                await agents.post_agent_configure({"key": key, "model": "hub-model", "runnerId": runner.id}, self.owner, self.session)
                resolve.assert_not_awaited()
                rpc.assert_awaited_once_with(runner, "agent.configure", {"key": key, "llm": {}}, timeout=60)


if __name__ == "__main__":
    unittest.main()
