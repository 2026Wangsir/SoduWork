"""Offline terminal boundary regressions: mocked auth/DB/PTY, real WS route.

No shell, model, network service or business database is started. Environment
markers are synthetic; Runner tests exercise the production environment builder.
"""
from __future__ import annotations

import asyncio
from contextlib import ExitStack, contextmanager
import json
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def setUpModule():
    global _resources, term, execution_sessions, local_base, runner_main, runner_environment
    _resources = ExitStack()
    temporary = _resources.enter_context(tempfile.TemporaryDirectory(prefix="soduwork-terminal-test-"))
    _resources.enter_context(patch.dict(os.environ, {"SODUWORK_DATA_ROOT": temporary}))
    from app import config
    settings = config.Settings(
        _env_file=None, database_url="sqlite+aiosqlite:///:memory:",
        hub_local_execution_enabled=False, cluster_redis_url="",
        auth_secret="isolated-terminal-test-secret-over-32-characters",
        admin_pass="isolated-terminal-test-password", soduwork_env="development")
    _resources.enter_context(patch.object(config, "get_settings", return_value=settings))
    from app.api import term
    from app.services import execution_sessions, local_base
    from app.services.terminal_environment import runner_environment
    import runner_main


def tearDownModule():
    _resources.close()


class FakeTerm:
    def info(self): return {"mode": "shell", "alive": True}
    def subscribe(self, callback): return ""
    def unsubscribe(self, callback): pass
    def write(self, data): pass
    def resize(self, cols, rows): pass
    def close(self): pass


class TerminalRouteTests(unittest.TestCase):
    @contextmanager
    def route(self, *, local_allowed=False, remote=False, owner="device", online=True,
              owner_user="user", rebound_after_auth=False):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        client = SimpleNamespace(id="device", user_ref="user")
        task = SimpleNamespace(id="task", owner_client_id=owner, owner_user_id=owner_user)
        runner = SimpleNamespace(id="runner", host="employee-host", client_id="device",
                                 owner_user_id="", org_id="")

        class Session:
            async def __aenter__(self): return self
            async def __aexit__(self, *args): pass
            async def get(self, model, ident):
                return task if model is term.Task else client

        app = FastAPI()
        app.include_router(term.router)
        with ExitStack() as stack:
            def mocked(obj, name, value):
                return stack.enter_context(patch.object(obj, name, value))
            mocked(term, "SessionLocal", lambda: Session())
            auth = mocked(term.device_auth, "client_from_transport", AsyncMock(return_value=client))
            if rebound_after_auth:
                auth.side_effect = [client, SimpleNamespace(id="device", user_ref="second-user")]
            mocked(execution_sessions, "task_runner_route", AsyncMock(return_value={
                "runnerId": runner.id if remote else "", "ref": "run-ref", "host": runner.host}))
            mocked(term.execution_host_policy, "hub_local_allowed", lambda: local_allowed)
            workdir = mocked(term, "_workdir_of", AsyncMock(return_value=""))
            mocked(term, "_cli_sid_of", AsyncMock(return_value=("session-id", "opencode")))
            env = mocked(term, "_env_for_term", AsyncMock(return_value={"LOCAL_ONLY": "yes"}))
            mocked(term.pty_term, "available", lambda: (True, ""))
            opened = stack.enter_context(patch.object(term.pty_term, "open_term", return_value=FakeTerm()))
            mocked(term.runner_hub, "get", lambda _: runner if remote and online else None)
            mocked(term.environment_service, "task_runner_clients", AsyncMock(return_value={client.id}))
            mocked(term.environment_service, "task_runner_orgs", AsyncMock(return_value=set()))
            remote_opened = mocked(term.runner_hub, "term_open", AsyncMock(return_value={
                "ok": True, "info": {"alive": True}, "backlog": ""}))
            mocked(term.runner_hub, "term_detach", AsyncMock())
            with TestClient(app) as http:
                yield SimpleNamespace(http=http, opened=opened, remote_opened=remote_opened,
                                      env=env, workdir=workdir, client=client, session=Session())

    def frame(self, fixture, suffix=""):
        with fixture.http.websocket_connect(
            "/api/v1/term?device=device&task=task&session=credential&mode=shell" + suffix
        ) as websocket:
            return websocket.receive_json()

    def test_disabled_hub_never_builds_environment_or_opens_pty(self):
        with self.route() as fixture:
            self.assertEqual(self.frame(fixture)["t"], "err")
            fixture.opened.assert_not_called()
            fixture.env.assert_not_called()
            fixture.workdir.assert_not_called()

    def test_enabled_hub_retains_local_terminal(self):
        with self.route(local_allowed=True) as fixture:
            self.assertEqual(self.frame(fixture)["t"], "ready")
            fixture.opened.assert_called_once()
            self.assertEqual(fixture.opened.call_args.args[4], {"LOCAL_ONLY": "yes"})

    def test_disabled_hub_still_allows_owned_remote_without_hub_secrets(self):
        sentinels = {key: "hub-only-" + key for key in (
            "AUTH_SECRET", "DATABASE_URL", "ADMIN_PASS", "CLUSTER_REDIS_URL", "PATH", "HOME")}
        with self.route(remote=True) as fixture, patch.dict(os.environ, sentinels):
            fixture.env.side_effect = AssertionError("Remote terminal must never load Hub environment")
            self.assertEqual(self.frame(fixture)["t"], "ready")
            fixture.opened.assert_not_called()
            fixture.env.assert_not_called()
            spec = fixture.remote_opened.call_args.args[2]
            self.assertEqual(spec["ref"], "run-ref")
            self.assertEqual(spec["env"], {})
            for value in sentinels.values():
                self.assertNotIn(value, json.dumps(spec))

    def test_unowned_task_is_denied_before_either_execution_path(self):
        with self.route(remote=True, owner="someone-else") as fixture:
            self.assertEqual(self.frame(fixture)["t"], "err")
            fixture.opened.assert_not_called()
            fixture.remote_opened.assert_not_called()

    def test_same_device_new_account_cannot_open_local_or_remote_terminal(self):
        for remote in (False, True):
            with self.subTest(remote=remote), self.route(
                remote=remote, local_allowed=True, owner_user="previous-user"
            ) as fixture:
                self.assertEqual(self.frame(fixture)["t"], "err")
                fixture.opened.assert_not_called()
                fixture.remote_opened.assert_not_called()
                fixture.workdir.assert_not_called()

    def test_account_switch_during_terminal_registration_is_denied(self):
        with self.route(remote=True, rebound_after_auth=True) as fixture:
            self.assertEqual(self.frame(fixture)["t"], "err")
            fixture.opened.assert_not_called()
            fixture.remote_opened.assert_not_called()

    def test_same_device_new_account_cannot_read_close_or_open_workdir(self):
        from fastapi import HTTPException
        with self.route(remote=True, owner_user="previous-user") as fixture:
            for action in (term.term_info, term.term_close, term.open_workdir):
                with self.subTest(action=action.__name__), self.assertRaises(HTTPException) as denied:
                    asyncio.run(action("task", fixture.client, fixture.session))
                self.assertEqual(denied.exception.status_code, 404)
            fixture.opened.assert_not_called()
            fixture.remote_opened.assert_not_called()

    def test_offline_remote_never_falls_back_to_enabled_hub(self):
        with self.route(remote=True, online=False, local_allowed=True) as fixture:
            self.assertEqual(self.frame(fixture)["t"], "err")
            fixture.opened.assert_not_called()

    def test_support_and_task_info_respect_disabled_hub(self):
        with self.route() as fixture:
            self.assertFalse(asyncio.run(term.term_support(fixture.client))["ok"])
            self.assertFalse(asyncio.run(term.term_info("task", fixture.client, fixture.session))["supported"])

    def test_remote_task_info_remains_supported_with_disabled_hub(self):
        with self.route(remote=True) as fixture:
            self.assertTrue(asyncio.run(term.term_info("task", fixture.client, fixture.session))["supported"])

    def test_policy_is_rechecked_at_execution_boundary(self):
        websocket = SimpleNamespace(send_json=AsyncMock(), close=AsyncMock())
        with self.route() as fixture:
            asyncio.run(term._serve_terminal(websocket, "task", 100, 30, "shell", None))
            self.assertEqual(websocket.send_json.call_args.args[0]["code"], "HUB_LOCAL_EXECUTION_DISABLED")
            fixture.opened.assert_not_called()
            fixture.workdir.assert_not_called()


class RunnerEnvironmentTests(unittest.IsolatedAsyncioTestCase):
    async def test_runner_ignores_legacy_hub_env_and_preserves_own_environment(self):
        machine = runner_main.Runner.__new__(runner_main.Runner)
        machine.work_root = ""
        machine.loop = asyncio.get_running_loop()
        machine.bin = False
        machine._send = AsyncMock()
        own = {"PATH": "runner-bin", "HOME": "runner-home", "SYSTEMROOT": "runner-system",
               "RUNNER_LOCAL_VALUE": "runner-only", "NODE_OPTIONS": "unsafe-host-options"}
        with patch.dict(os.environ, own, clear=True), \
             patch.dict(local_base._RUNS, {}, clear=True), \
             patch.dict(runner_main._TERMS, {}, clear=True), \
             patch.dict(runner_main._TERM_SUBS, {}, clear=True), \
             patch.object(term.pty_term, "available", return_value=(True, "")), \
             patch.object(term.pty_term, "open_term", return_value=FakeTerm()) as opened:
            await machine._term_open({"id": "rpc", "task": "task", "mode": "shell",
                "env": {"PATH": "hub-bin", "AUTH_SECRET": "hub-secret", "DATABASE_URL": "hub-db"}})
            env = opened.call_args.args[4]
            for key in ("PATH", "HOME", "SYSTEMROOT", "RUNNER_LOCAL_VALUE"):
                self.assertEqual(env[key], own[key])
            for key in ("AUTH_SECRET", "DATABASE_URL", "NODE_OPTIONS"):
                self.assertNotIn(key, env)
            self.assertEqual(env["PYTHONUTF8"], "1")
            self.assertTrue(machine._send.call_args.args[0]["ok"])

    async def test_task_model_configuration_is_built_on_runner(self):
        run = {"taskId": "task", "cli": "opencode", "cfg": {"llm": {
            "base": "http://model.invalid/v1", "key": "task-scoped-model-key", "model": "fixture-model"}}}
        with patch.dict(local_base._RUNS, {"ref": run}, clear=True), \
             patch.dict(os.environ, {"PATH": "runner-bin", "HOME": "runner-home"}, clear=True):
            env = runner_environment("task", "ref", "opencode")
        self.assertEqual(env["PATH"], "runner-bin")
        self.assertEqual(env["SODUWORK_LLM_KEY"], "task-scoped-model-key")
        self.assertEqual(json.loads(env["OPENCODE_CONFIG_CONTENT"])["model"], "company/fixture-model")

    async def test_other_tasks_configuration_is_never_reused(self):
        with patch.dict(local_base._RUNS, {"ref": {"taskId": "other", "cfg": {"llm": {}}}}, clear=True):
            with self.assertRaisesRegex(ValueError, "不属于"):
                runner_environment("task", "ref", "opencode")

    async def test_missing_archived_credentials_use_runner_login_environment(self):
        with patch.dict(local_base._RUNS, {"ref": {"taskId": "task", "cfg": {}}}, clear=True), \
             patch.dict(os.environ, {"OPENAI_API_KEY": "runner-login"}, clear=True):
            self.assertEqual(runner_environment("task", "ref", "qwen")["OPENAI_API_KEY"], "runner-login")

    async def test_recovered_pi_keeps_bundled_node_launcher(self):
        with tempfile.TemporaryDirectory(prefix="soduwork-pi-terminal-") as directory, \
             patch.dict(local_base._RUNS, {"ref": {"taskId": "task", "cli": "pi", "cfg": {}}}, clear=True), \
             patch.object(local_base, "_bundled_pi_node", return_value="bundled-electron"), \
             patch.dict(os.environ, {"PATH": "runner-bin", "SODUWORK_DATA_ROOT": directory}, clear=True):
            env = runner_environment("task", "ref", "pi")
        self.assertEqual(env["ELECTRON_RUN_AS_NODE"], "1")
        self.assertNotIn("SODUWORK_LLM_KEY", env)


if __name__ == "__main__":
    unittest.main()
