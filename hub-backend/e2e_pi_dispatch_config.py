"""Managed Pi dispatch with inherited desktop configuration, a real Hub and Runner.

Run with the backend venv; optional --runner-exe validates the frozen artifact.
No live accounts, production Hub, paid model, or user workspace is used.
"""
import argparse
import asyncio
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile


async def run(root, executable=None):
    from app import config as app_config
    from quality_gate import _isolated_env
    for key in app_config.Settings.model_fields:
        os.environ.pop(key.upper(), None)
    os.environ.update(_isolated_env(dict(os.environ), root, 0, "pi-dispatch-config"))
    settings = app_config.Settings(_env_file=None,
        database_url="sqlite+aiosqlite:///" + (root / "test.db").as_posix(),
        auth_secret="isolated-pi-dispatch-fixture-signing-key", cluster_redis_url="",
        report_auto=False, repository_sync_interval_seconds=0)
    app_config.get_settings = lambda: settings
    from fastapi import FastAPI, Request
    from fastapi.responses import StreamingResponse
    import httpx
    import uvicorn
    from app import models
    from app.db import Base, engine, SessionLocal
    from app.api import runner_ws, agents, tasks
    from app.services import device_auth, runner_hub

    backend = Path(__file__).resolve().parent
    client = backend.parent / "client"
    app = FastAPI()
    app.include_router(runner_ws.router)
    app.include_router(agents.router)
    app.include_router(tasks.router)
    model_requests = []

    @app.post("/v1/chat/completions")
    async def completion(request: Request):
        body = await request.json()
        assert request.headers.get("authorization") == "Bearer loopback-fixture"
        assert body.get("model") == "dispatch-fixture"
        model_requests.append({"model": body.get("model"), "retainedResult": "PI_DISPATCH_OK" in json.dumps(body.get("messages"))})
        used_tool = any(m.get("role") == "tool" for m in body.get("messages", []))
        if used_tool:
            delta, finish = {"role": "assistant", "content": "PI_DISPATCH_OK"}, "stop"
        else:
            delta, finish = {"role": "assistant", "tool_calls": [{"index": 0, "id": "fixture-write",
                "type": "function", "function": {"name": "write", "arguments": json.dumps({
                    "path": "dispatch-result.txt", "content": "PI_DISPATCH_OK"})}}]}, "tool_calls"
        messages = []
        for content, end in [(delta, None), ({}, finish)]:
            messages.append("data: " + json.dumps({"id": "fixture", "object": "chat.completion.chunk",
                "created": 1, "model": "dispatch-fixture", "choices": [{"index": 0, "delta": content,
                "finish_reason": end}]}) + "\n\n")
        return StreamingResponse(iter(messages + ["data: [DONE]\n\n"]), media_type="text/event-stream")

    secret = "dispatch-fixture-secret-" + "x" * 32
    async with engine.begin() as connection:
        await connection.run_sync(Base.metadata.create_all)
    async with SessionLocal() as session:
        session.add(models.User(id="fixture-user", username="pi-dispatch-fixture", is_active=True))
        session.add(models.Client(id="fixture-dispatch-device", name="Pi dispatch fixture",
                                  user_ref="fixture-user", auth_state="active",
                                  secret_hash=device_auth.hash_secret(secret)))
        await session.commit()
        api_session, _ = device_auth.issue_session(await session.get(models.Client, "fixture-dispatch-device"))
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    base = "http://127.0.0.1:" + str(sock.getsockname()[1])
    server = uvicorn.Server(uvicorn.Config(app, log_level="warning", access_log=False))
    serving = asyncio.create_task(server.serve(sockets=[sock]))
    while not server.started:
        if serving.done():
            await serving
        await asyncio.sleep(0.02)

    data = root / "runner-data"
    data.mkdir()
    desktop = root / "desktop-pi"
    personal = root / "profile/.pi/agent"
    original = json.dumps({"providers": {"personal": {"api": "openai-completions",
        "baseUrl": "http://127.0.0.1:9/v1", "models": [{"id": "personal-only"}]}}})
    for directory in (desktop, personal):
        directory.mkdir(parents=True)
        (directory / "models.json").write_text(original, encoding="utf-8")
    env = dict(os.environ, PYTHONUTF8="1", PYTHONIOENCODING="utf-8", HOME=str(root / "profile"),
               USERPROFILE=str(root / "profile"), SODUWORK_DATA_ROOT=str(data),
               SODUWORK_BUNDLED_PI_CLI=str(client / "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
               SODUWORK_BUNDLED_NODE=shutil.which("node") or "", SODUWORK_DEVICE_SECRET=secret,
               SODUWORK_SKILL_ROOTS=str(root / "skills"))
    for key in ("SODUWORK_HUB", "SODUWORK_RUNNER_ID", "SODUWORK_RUNNER_KEY", "SODUWORK_RUNNER_TOKEN",
                "PI_CODING_AGENT_DIR", "SODUWORK_PROXY_KEY", "SODUWORK_MCP_KEY", "NODE_OPTIONS", "ELECTRON_RUN_AS_NODE",
                "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        env.pop(key, None)
    env["PI_CODING_AGENT_DIR"] = str(desktop)
    env["PI_CODING_AGENT_SESSION_DIR"] = str(desktop / "sessions")
    config = dict(hub=base, clientId="fixture-dispatch-device", dataRoot=str(data),
                  workRoot=str(root / "work"), tags=["soduwork-client"], capabilityGrants=[])
    processes, readers, statuses = [], [], []

    async def start(label):
        command = [str(executable)] if executable else [sys.executable, str(backend / "runner_main.py")]
        with (root / (label + ".stderr.log")).open("wb") as errors:
            child = await asyncio.create_subprocess_exec(*command, "--config-stdin", cwd=root, env=env,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=errors,
                creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0)
        processes.append(child)
        async def read():
            async for line in child.stdout:
                prefix = b"@@SODUWORK_RUNNER_STATUS@@"
                if line.startswith(prefix):
                    statuses.append(json.loads(line[len(prefix):]))
        readers.append(asyncio.create_task(read()))
        child.stdin.write(("@@SODUWORK_RUNNER_CONFIG@@" + json.dumps(config) + "\n").encode())
        await child.stdin.drain()
        return child

    try:
        current = await start("dispatched")
        runner = None
        for _ in range(120):
            runner = runner_hub.for_client("fixture-dispatch-device")
            if runner and runner.ready and runner.inventory_ready and runner.agents:
                break
            if current.returncode is not None:
                raise AssertionError("Runner exited: " + (root / "dispatched.stderr.log").read_text(errors="replace")[-2500:])
            await asyncio.sleep(0.25)
        assert runner and runner.ready and runner.agents, "Runner must advertise real installed Agents"
        async with httpx.AsyncClient(base_url=base, headers={"X-Soduwork-Device": "fixture-dispatch-device",
                                                         "Authorization": "Device " + api_session}, timeout=40, trust_env=False) as api:
            setup = await api.get("/api/v1/agent-setup")
            roster = await api.get("/api/v1/ai-agents")
            assert setup.status_code == 200 and roster.status_code == 200, (setup.status_code, roster.status_code)
            assert setup.json()["machines"] and setup.json()["agents"]
            assert any(a.get("cli") == "pi" for a in roster.json()["agents"]), roster.json()
        print("PASS Agent management and automation roster discover local Pi", flush=True)
        result = await runner.call("job.dispatch", dict(cli="pi", dispatchId="fixture-pi-dispatch-dispatch",
            task=dict(id="fixture-pi-dispatch-task", title="Pi dispatch verification", note="write dispatch-result.txt"),
            cfg=dict(local_cli="pi", llm=dict(base=base + "/v1", key="loopback-fixture", model="dispatch-fixture")),
            ctx=dict(workspace=dict(workRoot=str(root / "work")), workRoot=str(root / "work"),
                     workDir=str(root / "work"), requiredAgentCapabilities=[], expectedOutputs=["dispatch-result.txt"])), timeout=35)
        assert result.get("ok"), result
        ref = result["data"]["ref"]
        final = {}
        for _ in range(120):
            status = await runner.call("job.status", {"ref": ref}, timeout=10)
            final = status.get("data") or {}
            if final.get("status") in ("done", "completed", "failed", "cancelled", "error"):
                break
            await asyncio.sleep(0.25)
        assert final.get("status") in ("done", "completed"), final
        artifact = Path(final["workDirAbs"]) / "dispatch-result.txt"
        assert artifact.read_text(encoding="utf-8") == "PI_DISPATCH_OK" and model_requests
        print("PASS real Hub dispatch -> Runner -> Pi -> loopback model -> file artifact", flush=True)
        native_sessions = list((data / "agent-runtimes/pi").glob("*/sessions/*.jsonl"))
        assert len(native_sessions) == 1, native_sessions
        legacy = desktop / "sessions" / native_sessions[0].name
        legacy.parent.mkdir()
        original_session = native_sessions[0].read_bytes()
        legacy.write_bytes(original_session)
        native_sessions[0].unlink()
        before = len(model_requests)
        reply = await runner.call("job.comment", {"ref": ref, "text": "Confirm the existing result again.",
            "recordUser": True, "cfg": {"llm": {"base": base + "/v1", "key": "loopback-fixture",
            "model": "dispatch-fixture"}}, "commentId": "pi-config-followup"}, timeout=35)
        assert reply.get("ok"), reply
        for _ in range(160):
            status = await runner.call("job.status", {"ref": ref}, timeout=10)
            final = status.get("data") or {}
            if len(model_requests) > before and final.get("status") in ("done", "completed"):
                break
            await asyncio.sleep(0.25)
        assert len(model_requests) > before and final.get("status") in ("done", "completed"), final
        assert any(row["retainedResult"] for row in model_requests[before:]), "Resume must retain the prior model context"
        assert legacy.read_bytes() == original_session
        assert native_sessions[0].is_file()
        print("PASS upgraded execution imports only its owned session and retains model context", flush=True)

        # Runner archives deliberately omit credentials. A native recovery
        # terminal must still resolve the same owned session after restart.
        current.stdin.close()
        await asyncio.wait_for(current.wait(), 15)
        previous_runner = runner
        env["SODUWORK_LLM_KEY"] = "unrelated-inherited-fixture-key"
        current = await start("recovered")
        for _ in range(120):
            runner = runner_hub.for_client("fixture-dispatch-device")
            if runner and runner is not previous_runner and runner.ready and runner.inventory_ready:
                break
            assert current.returncode is None, "Recovered Runner exited"
            await asyncio.sleep(0.25)
        assert runner and runner is not previous_runner and runner.ready
        recovered = (await runner.call("job.info", {"ref": ref}, timeout=10))["data"]
        assert recovered["cliSid"] == json.loads(original_session.splitlines()[0])["id"]
        terminal_output = []
        def terminal_data(chunk):
            if chunk:
                terminal_output.append(chunk)
        before = len(model_requests)
        opened = await runner_hub.term_open(runner, "fixture-pi-dispatch-task", {
            "ref": ref, "cli": "pi", "sid": recovered["cliSid"],
            "ws": recovered["workDirAbs"], "mode": "session", "cols": 140, "rows": 40,
        }, terminal_data)
        try:
            assert opened.get("ok"), opened
            terminal_output.append(opened.get("backlog") or "")
            assert recovered["cliSid"] in opened["info"]["cmd"]
            for _ in range(120):
                output = "".join(terminal_output)
                if "PI_DISPATCH_OK" in output:
                    break
                assert "No session found" not in output, output
                await asyncio.sleep(0.1)
            assert "PI_DISPATCH_OK" in "".join(terminal_output), "Recovered terminal must display the original result"
            assert len(model_requests) == before, "Opening history must not invoke a model"
        finally:
            await runner_hub.term_close(runner, "fixture-pi-dispatch-task")
        print("PASS restarted Runner opens the same native Pi terminal without model credentials", flush=True)
        for directory in (desktop, personal):
            assert (directory / "models.json").read_text(encoding="utf-8") == original
        configs = list((data / "agent-runtimes/pi").glob("*/models.json"))
        assert len(configs) == 1, configs
        assert "loopback-fixture" not in configs[0].read_text(encoding="utf-8")
        assert list((desktop / "sessions").iterdir()) == [legacy]
        report = {"ok": True, "checks": ["authenticated Hub and native Runner handshake",
            "managed Pi dispatch despite inherited desktop directory", "real Pi writes an artifact",
            "upgrade and follow-up preserve the exact owned native session", "personal and desktop models unchanged",
            "restarted Runner opens owned native history without invoking the model",
            "model key remains outside models.json"], "modelRequests": len(model_requests)}
        (root / "report.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
        print("PASS personal models, desktop sessions and credential boundaries remain isolated", flush=True)
    finally:
        for child in processes:
            if child.returncode is None:
                child.stdin.close()
                await asyncio.wait_for(child.wait(), 15)
        await asyncio.gather(*readers)
        server.should_exit = True
        await asyncio.wait_for(serving, 15)
        await engine.dispose()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--runner-exe", type=Path)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    # Keep isolated evidence for diagnosis; every run gets a fresh database.
    root = Path(tempfile.mkdtemp(prefix=".smoke-pi-dispatch-", dir=args.output.resolve()))
    print("Fixture evidence: " + str(root), flush=True)
    asyncio.run(run(root, args.runner_exe.resolve() if args.runner_exe else None))
