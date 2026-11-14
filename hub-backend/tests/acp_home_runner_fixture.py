"""Real Runner admission/process/ACP chain with a synthetic vendor boundary."""
from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BACKEND = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND))


def peer(home_key, expected_home, marker, local_only=""):
    assert os.environ[home_key] == expected_home
    assert Path(expected_home).is_dir()
    Path(marker).write_text("executor-started", encoding="utf-8")
    if local_only and home_key == "QWEN_HOME":
        assert os.environ["OPENAI_MODEL"] == "local-keyless"
        assert "OPENAI_API_KEY" not in os.environ
        assert os.environ.get("SODUWORK_QWEN_MODEL_LABEL")
    if local_only and home_key == "CODEX_HOME":
        gateway = json.loads(os.environ["DEFAULT_AUTH_REQUEST"])["_meta"]["gateway"]
        assert "Authorization" not in gateway["headers"]
    sid = "private-home-fixture"
    for raw in sys.stdin:
        request = json.loads(raw)
        method = request.get("method")
        if method == "initialize":
            result = {"protocolVersion": 1, "agentCapabilities": {"loadSession": True}}
        elif method == "session/new":
            result = {"sessionId": sid, "models": {"availableModels": [
                {"modelId": "fixture-route", "name": os.environ.get("SODUWORK_QWEN_MODEL_LABEL", "fixture")}]}}
        elif method == "session/set_model":
            result = {}
        elif method == "session/prompt":
            print(json.dumps({"jsonrpc": "2.0", "method": "session/update", "params": {
                "sessionId": sid, "update": {"sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "Private home execution completed."}}}}), flush=True)
            result = {"stopReason": "end_turn"}
        else:
            raise AssertionError(method)
        print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)


async def run(agent, root):
    root.mkdir(parents=True)
    data = root / "runner-data"
    data.mkdir()
    workspace = root / "workspace"
    workspace.mkdir()
    personal = root / "personal"
    personal.mkdir()
    private_file = personal / "private.json"
    private_file.write_text("untouched-personal-state", encoding="utf-8")
    os.environ.update(SODUWORK_DATA_ROOT=str(data), HOME=str(root / "home"),
                      USERPROFILE=str(root / "home"), SODUWORK_LOCAL_STALL_RETRIES="0")
    from app.services import local_base, local_stream, local_process, acp_agents
    import runner_main
    spec = acp_agents.CATALOG[agent]["home"]
    os.environ[spec["env"]] = str(personal)
    home = data / spec["folder"]
    home.write_text("existing-file-must-not-be-deleted", encoding="utf-8")
    marker = root / "executor-started"
    profile = local_base._PROFILES[agent]
    profile["bin"] = lambda: sys.executable
    profile.pop("runtime_probe", None)
    profile.pop("runtime_issue", None)
    commands = []

    class Gateway(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b'{"data":[]}')

        def log_message(self, *_args):
            pass

    gateway = ThreadingHTTPServer(("127.0.0.1", 0), Gateway)
    serving = threading.Thread(target=gateway.serve_forever, daemon=True)
    serving.start()

    def argv(exe, args, ws, cfg, prof):
        # Replace only the vendor executable; real environment preparation,
        # admission, durable sidecar and ACP protocol bridge remain active.
        commands.append(True)
        return [sys.executable, str(BACKEND / "app/services/acp_bridge.py"),
                "--cwd", ws, "--agent-name", agent, "--permission", "workspace", "--",
                sys.executable, str(Path(__file__).resolve()), "--peer", spec["env"], str(home), str(marker),
                "local" if (cfg.get("llm") or {}).get("localOnly") else ""]

    local_process._command_argv = argv
    machine = runner_main.Runner("http://127.0.0.1:1", "fixture", "fixture", "fixture", str(workspace))
    machine._resource_budget.sampler = lambda: {"cpuCount": 8, "cpuPercent": 20.0,
        "memoryTotalBytes": 16 * 1024**3, "memoryAvailableBytes": 12 * 1024**3}
    refs = []

    async def dispatch(label, local_model=False):
        reply = await machine._job({"op": "job.dispatch", "cli": agent, "dispatchId": label,
            **({"_localParent": True} if local_model else {}),
            "task": {"id": "fixture-" + label, "title": "Private home verification", "note": "Complete verification"},
            "ctx": {"workDir": str(workspace), "workRoot": str(workspace)}, "cfg": {
                "llm": {"base": f"http://127.0.0.1:{gateway.server_port}/v1",
                        "key": "" if local_model else "synthetic-model-key",
                        "model": "local-keyless" if local_model else "fixture",
                        **({"localOnly": True, "authMode": "none"} if local_model else {})}}})
        assert reply["ok"], reply
        ref = reply["data"]["ref"]
        refs.append(ref)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            result = (await machine._job({"op": "job.session", "ref": ref, "limit": 1000,
                **({"_localParent": True} if local_model else {})}))["data"]
            if result.get("status") in {"done", "failed", "stopped"}:
                return result
            await asyncio.sleep(.05)
        raise AssertionError("Runner did not settle")

    try:
        failed = await dispatch("blocked")
        assert failed["status"] == "failed" and "独立数据目录无法创建" in failed["error"], failed
        assert not marker.exists() and not commands
        assert home.read_text() == "existing-file-must-not-be-deleted"
        assert str(personal) not in failed["error"] and str(home) not in failed["error"]
        home.unlink()  # Repair only this synthetic fixture's deliberate collision.
        healthy = await dispatch("repaired")
        assert healthy["status"] == "done", healthy
        assert marker.read_text() == "executor-started" and len(commands) == 1
        assert home.is_dir()
        local = await dispatch("local-keyless", local_model=True)
        assert local["status"] == "done", local
        assert len(commands) == 2
        assert local["model"] == "local-keyless", local
        assert local["usageReceipts"] == [], local
        assert private_file.read_text() == "untouched-personal-state"
        assert list(personal.iterdir()) == [private_file]
        print(json.dumps({"ok": True, "agent": agent, "blockedBeforeExecutor": True,
            "healthyRetry": True, "personalStateUnchanged": True, "localModelReady": True}), flush=True)
    finally:
        for ref in refs:
            if local_stream.is_running(ref):
                await asyncio.to_thread(local_stream.stop_sync, {}, ref)
        if machine._admission_task:
            machine._admission_task.cancel()
            await asyncio.gather(machine._admission_task, return_exceptions=True)
        await asyncio.gather(*machine._admission_workers, return_exceptions=True)
        for thread in list(local_base._THREADS):
            await asyncio.to_thread(thread.join, 3)
        gateway.shutdown()
        gateway.server_close()
        serving.join(2)


if __name__ == "__main__":
    if sys.argv[1] == "--peer":
        peer(*sys.argv[2:])
    else:
        asyncio.run(run(sys.argv[1], Path(sys.argv[2]).resolve()))
