"""Private probe routing and real child processes with synthetic Agent responses."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

from app.agent_catalog import AGENTS
from app.services import agent_setup, dsh_runtime, local_base
from runner_main import Runner


LOCAL = {"localOnly": True, "base": "http://private-probe.invalid/v1", "key": "private-probe-key",
         "model": "private-probe-wire", "authMode": "api-key"}


class PrivateProbeRoutingTests(unittest.IsolatedAsyncioTestCase):
    async def test_only_parent_pipe_can_start_and_poll_private_managed_probes(self):
        machine = Runner.__new__(Runner)
        jobs = []
        try:
            with patch.object(agent_setup, "_spawn"):
                for key, spec in AGENTS.items():
                    if spec["modelMode"] != "managed":
                        continue
                    result = await machine._local_rpc_dispatch({"op": "agent.probe", "key": key, "llm": LOCAL})
                    self.assertTrue(result["ok"], result)
                    identity = result["data"]["jobId"]
                    jobs.append(identity)
                    self.assertTrue(result["data"]["private"])
                    private = await machine._local_rpc_dispatch({"op": "agent.job", "jobId": identity})
                    self.assertTrue(private["data"]["private"])
                    self.assertEqual(private["data"]["lines"], [])
                    remote = await machine._agent({"op": "agent.job", "jobId": identity})
                    self.assertFalse(remote["ok"])
                    self.assertIsNone(agent_setup.job(identity))
                for key in ("codex", "claude"):
                    denied = await machine._local_rpc_dispatch({"op": "agent.probe", "key": key, "llm": LOCAL})
                    self.assertFalse(denied["ok"])
        finally:
            for identity in jobs:
                agent_setup._JOBS.pop(identity, None)

    async def test_network_marker_cannot_authorize_local_probe_or_configuration(self):
        machine = Runner.__new__(Runner)
        machine._send = AsyncMock()
        with patch.object(agent_setup, "start_probe") as start, patch.object(agent_setup, "configure") as configure:
            for operation in ("agent.probe", "agent.configure"):
                await machine._on({"op": operation, "id": "remote", "key": "qwen", "llm": LOCAL,
                                   "_localParent": True})
                result = machine._send.await_args.args[0]
                self.assertFalse(result["ok"])
                self.assertEqual(result["code"], "LOCAL_MODEL_REMOTE_FORBIDDEN")
            start.assert_not_called()
            configure.assert_not_called()


class PrivateProbeProcessTests(unittest.TestCase):
    def test_dsh_private_probe_reuses_installed_code_but_cleans_its_own_home_and_temp(self):
        identity = agent_setup._new_job("dsh", "probe", private=True)
        roots = []
        original = local_base._env_for

        def prepare(*args, **kwargs):
            roots.append(kwargs["runtime_root"])
            return original(*args, **kwargs)

        try:
            with tempfile.TemporaryDirectory(prefix="soduwork-dsh-installed-") as data:
                installed = Path(dsh_runtime.host_root(data))
                package = installed / "node_modules" / "@deepseek-ai" / "dsh" / "package.json"
                package.parent.mkdir(parents=True)
                package.write_text('{"version":"fixture"}', encoding="utf-8")
                before = package.read_bytes()

                def command(_bin, _args, workspace, _cfg, _prof):
                    source = "\n".join([
                        "import json, os",
                        "from pathlib import Path",
                        "installed = Path(" + repr(str(installed)) + ")",
                        "root = Path(" + repr(roots[-1]) + ").resolve()",
                        "workspace = Path(" + repr(workspace) + ").resolve()",
                        "assert Path(os.environ['DSH_PATH']).resolve() == installed.resolve()",
                        "assert (installed / 'node_modules/@deepseek-ai/dsh/package.json').is_file()",
                        "home, temporary = Path(os.environ['DSH_HOME']).resolve(), Path(os.environ['TMPDIR']).resolve()",
                        "assert home.is_relative_to(root) and temporary.is_relative_to(root)",
                        "assert not temporary.is_relative_to(workspace) and not workspace.is_relative_to(temporary)",
                        "assert os.environ['DSH_PERMISSION_MODE'] == 'read-only'",
                        "(home / 'private-probe-state').write_text('isolated')",
                        "print(json.dumps(" + repr({"type": "text", "part": {"text": agent_setup._TOKEN}}) + "), flush=True)",
                    ])
                    return [sys.executable, "-c", source]

                with patch.object(local_base, "_data_root", return_value=data), \
                        patch.object(agent_setup, "_bin_of", return_value=sys.executable), \
                        patch.object(agent_setup, "_short", return_value="fixture-version"), \
                        patch.dict(agent_setup._PROFILES["dsh"], {"start": lambda *args: ["fixture"]}), \
                        patch.object(agent_setup, "_command_argv", side_effect=command), \
                        patch.object(local_base, "_env_for", side_effect=prepare), \
                        patch.object(agent_setup, "_save_probe") as save:
                    agent_setup._guard(identity, agent_setup._run_probe, "dsh", dict(LOCAL))
                result = agent_setup.job(identity, include_private=True)
                self.assertTrue(result["ok"], result)
                self.assertEqual(result["state"], "done")
                self.assertEqual(result["lines"], [])
                self.assertNotIn("private-probe", json.dumps(result))
                save.assert_not_called()
                self.assertEqual(package.read_bytes(), before)
                self.assertEqual([p for p in installed.rglob('*') if p.is_file()], [package])
                self.assertTrue(roots)
                self.assertTrue(all(not Path(root).exists() for root in roots))
        finally:
            agent_setup._JOBS.pop(identity, None)

    def run_process(self, key, *, success=True):
        identity = agent_setup._new_job(key, "probe", private=True)
        roots = []
        original = local_base._env_for
        def prepare(*args, **kwargs):
            roots.append(kwargs["runtime_root"])
            return original(*args, **kwargs)
        output = {"type": "text", "part": {"text": agent_setup._TOK_A + agent_setup._TOK_B}}
        if not success:
            output = {"type": "error", "message": "private-probe-wire private-probe-key http://private-probe.invalid/v1"}
        source = "import json; print(" + repr(json.dumps(output)) + ",flush=True)"
        if key == "harness2" and success:
            source += "; print(" + repr(json.dumps({"type": "harness2_probe_complete",
                "coverage": "native-execute-v1", "stages": 0})) + ",flush=True)"
        try:
            with tempfile.TemporaryDirectory() as data:
                history = Path(data) / "agent-probe.json"
                history.write_text(json.dumps({key: {"ok": True, "detail": "previous Hub model result"}}))
                before = history.read_bytes()
                with patch.object(agent_setup, "_PROBE_FILE", str(history)), \
                        patch.object(agent_setup, "_bin_of", return_value=sys.executable), \
                        patch.object(agent_setup, "_short", return_value="fixture-version"), \
                        patch.dict(agent_setup._PROFILES[key], {"start": lambda *args: ["fixture"]}), \
                        patch.object(agent_setup, "_command_argv", return_value=[sys.executable, "-c", source]), \
                        patch.object(local_base, "_env_for", side_effect=prepare):
                    agent_setup._guard(identity, agent_setup._run_probe, key, dict(LOCAL))
                result = agent_setup.job(identity, include_private=True)
                self.assertEqual(result["state"], "done")
                self.assertEqual(result["ok"], success, result)
                self.assertEqual(result["lines"], [])
                self.assertEqual(history.read_bytes(), before)
                self.assertNotIn("private-probe", json.dumps(result))
                self.assertTrue(roots)
                self.assertTrue(all(not Path(root).exists() for root in roots))
                self.assertIsNone(agent_setup.job(identity))
                return roots
        finally:
            agent_setup._JOBS.pop(identity, None)

    def test_every_managed_runtime_executes_a_real_child_without_persisting_private_results(self):
        for key, spec in AGENTS.items():
            if spec["modelMode"] == "managed":
                with self.subTest(key=key):
                    self.run_process(key)

    def test_failure_output_does_not_enter_history_and_temporary_configuration_is_removed(self):
        self.run_process("qwen", success=False)

    def test_private_unhandled_errors_cannot_enter_job_logs_or_public_diagnostics(self):
        identity = agent_setup._new_job("qwen", "probe", private=True)
        try:
            def fail(*args):
                raise RuntimeError("private-probe-wire private-probe-key http://private-probe.invalid/v1")
            with patch.object(agent_setup.log, "exception") as log:
                agent_setup._guard(identity, fail)
                log.assert_not_called()
            result = agent_setup.job(identity, include_private=True)
            self.assertFalse(result["ok"])
            self.assertEqual(result["lines"], [])
            self.assertNotIn("private-probe", json.dumps(result))
        finally:
            agent_setup._JOBS.pop(identity, None)

    def test_concurrent_private_probes_use_separate_roots(self):
        identities = [agent_setup._new_job("pi", "probe", private=True) for _ in range(2)]
        roots = []
        original = local_base._env_for
        def prepare(*args, **kwargs):
            roots.append(kwargs["runtime_root"])
            return original(*args, **kwargs)
        source = "import json,time; time.sleep(.05); print(" + repr(json.dumps({
            "type": "text", "part": {"text": agent_setup._TOKEN}})) + ",flush=True)"
        try:
            with patch.object(agent_setup, "_bin_of", return_value=sys.executable), \
                    patch.object(agent_setup, "_short", return_value="fixture-version"), \
                    patch.dict(agent_setup._PROFILES["pi"], {"start": lambda *args: ["fixture"]}), \
                    patch.object(agent_setup, "_command_argv", return_value=[sys.executable, "-c", source]), \
                    patch.object(local_base, "_env_for", side_effect=prepare), ThreadPoolExecutor(max_workers=2) as pool:
                list(pool.map(lambda identity: agent_setup._guard(identity, agent_setup._run_probe, "pi", dict(LOCAL)), identities))
            self.assertEqual(len(set(roots)), 2)
            self.assertTrue(all(not Path(root).exists() for root in roots))
            self.assertTrue(all(agent_setup.job(identity, include_private=True)["ok"] for identity in identities))
        finally:
            for identity in identities:
                agent_setup._JOBS.pop(identity, None)


if __name__ == "__main__":
    unittest.main()
