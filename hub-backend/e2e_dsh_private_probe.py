"""Exercise an installed DSH through the real private probe and loopback model.

All mutable state is disposable. Explicit adapter/runtime paths are read-only
inputs; no installation, production account, Hub, or live model is used.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import shlex
import subprocess
import tempfile
import threading
import time
from unittest.mock import patch


def run(args, root: Path) -> dict:
    adapter = args.adapter_entry.resolve(strict=True)
    runtime = args.runtime_root.resolve(strict=True)
    node = args.node.resolve(strict=True)
    adapter_manifest = adapter.parent.parent / "package.json"
    host_manifest = runtime / "node_modules/@deepseek-ai/dsh/package.json"
    versions = {
        "adapter": json.loads(adapter_manifest.read_text())["version"],
        "host": json.loads(host_manifest.read_text())["version"],
        "node": subprocess.check_output([str(node), "--version"], text=True).strip(),
    }
    fingerprints = {p: hashlib.sha256(p.read_bytes()).hexdigest()
                    for p in (adapter, adapter_manifest, host_manifest)}
    install_root = root / "install-data"
    host_link = install_root / "agent-runtimes/dsh-host"
    host_link.parent.mkdir(parents=True)
    if os.name == "nt":
        shutil.copytree(runtime, host_link)
    else:
        host_link.symlink_to(runtime, target_is_directory=True)
    home = root / "home"
    home.mkdir()
    temporary = root / "tmp"
    temporary.mkdir()
    executable = root / ("dsh-acp.cmd" if os.name == "nt" else "dsh-acp")
    executable.write_text((f'@"{node}" "{adapter}" %*\r\n' if os.name == "nt" else
                           "#!/bin/sh\nexec " + shlex.quote(str(node)) + " " + shlex.quote(str(adapter)) + ' "$@"\n'), encoding="utf-8")
    executable.chmod(0o700)
    requests, failures, processes, observations = [], [], [], []
    fixture_key, fixture_model = "private-probe-fixture-key", "private-probe-fixture-model"
    marker = "SODUWORK_" + "AGENT_OK"

    class Provider(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("Content-Length", "0"))))
                assert self.path == "/v1/chat/completions", "Unexpected model route"
                assert self.headers.get("Authorization") == "Bearer " + fixture_key, "Fixture credential was not used"
                assert body.get("model") == fixture_model, "Fixture model was not used"
                assert marker not in json.dumps(body.get("messages")), "The request already contains the answer"
                assert "AGENT_OK" in json.dumps(body.get("messages")), "Missing probe prompt"
                requests.append({"path": self.path, "stream": body.get("stream") is True,
                                 "model": fixture_model, "fixtureCredential": True})
                if body.get("stream"):
                    chunks = []
                    for delta, finish in [({"role": "assistant", "content": marker}, None), ({}, "stop")]:
                        event = {"id": "fixture-completion", "object": "chat.completion.chunk", "created": 1,
                                 "model": fixture_model, "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
                        chunks.append("data: " + json.dumps(event) + "\n\n")
                    data = ("".join(chunks) + "data: [DONE]\n\n").encode()
                    content_type = "text/event-stream"
                else:
                    data = json.dumps({"id": "fixture-completion", "object": "chat.completion", "created": 1,
                        "model": fixture_model, "choices": [{"index": 0, "message": {"role": "assistant", "content": marker},
                        "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 4, "total_tokens": 14}}).encode()
                    content_type = "application/json"
                self.send_response(200)
                self.send_header("Content-Type", content_type)
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)
            except Exception as exc:
                failures.append(str(exc))
                self.send_error(400, "Fixture request rejected")

    server = ThreadingHTTPServer(("127.0.0.1", 0), Provider)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{server.server_port}/v1"
    environment = {
        "PATH": str(node.parent) + os.pathsep + os.defpath, "HOME": str(home), "USERPROFILE": str(home),
        "TMP": str(temporary), "TEMP": str(temporary), "TMPDIR": str(temporary),
        "XDG_CACHE_HOME": str(home / "cache"), "XDG_CONFIG_HOME": str(home / "config"),
        "XDG_DATA_HOME": str(home / "data"), "APPDATA": str(home / "appdata"),
        "LOCALAPPDATA": str(home / "localappdata"), "SODUWORK_DATA_ROOT": str(install_root),
        "DSH_ACP_CACHE_DIR": str(home / "dsh-acp-cache"), "DSH_TELEMETRY_DISABLED": "1",
        "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost",
        "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
    }
    for key in ("SYSTEMROOT", "WINDIR", "COMSPEC"):
        if os.environ.get(key):
            environment[key] = os.environ[key]
    guard = root / "loopback-only.cjs"
    guard.write_text("""'use strict';
const net = require('node:net');
const original = net.Socket.prototype.connect;
net.Socket.prototype.connect = function(...args) {
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = first && typeof first === 'object' ? first : {port:first,host:typeof args[1]==='string'?args[1]:'localhost'};
  if (options.path || !['127.0.0.1','localhost','::1'].includes(String(options.host || 'localhost')))
    throw Error('E2E_NON_LOOPBACK_CONNECTION_BLOCKED');
  return original.apply(this,args);
};
""", encoding="utf-8")
    report = {"ok": False, "versions": versions, "requests": requests, "observations": observations,
              "boundary": "Real installed DSH adapter and host, production private agent_setup job and ACP bridge, synthetic loopback provider. Installation discovery is explicit; no Electron UI, real credentials, production Hub, paid model or user workspace."}
    try:
        # Import after isolating the process environment, including configuration defaults.
        with patch.dict(os.environ, environment, clear=True), ExitStack() as stack:
            stack.enter_context(patch.object(tempfile, "tempdir", str(temporary)))
            from app.services import agent_npm_runtime, agent_setup, dsh_runtime, local_base
            profile = {**local_base._PROFILES["dsh"], "bin": lambda: str(executable)}
            stack.enter_context(patch.dict(local_base._PROFILES, {"dsh": profile}))
            stack.enter_context(patch.object(agent_npm_runtime, "package_entry", lambda *_args, **_kwargs: str(adapter)))
            stack.enter_context(patch.object(agent_npm_runtime, "node_env", lambda *_args, **_kwargs: {"ok": True, "nodePath": str(node)}))
            stack.enter_context(patch.object(local_base, "_data_root", lambda: str(install_root)))
            stack.enter_context(patch.object(agent_setup, "_data_root", lambda: str(install_root)))
            stack.enter_context(patch.object(agent_setup, "_save_probe", side_effect=AssertionError("Private probes must not persist results")))
            original_popen, original_stream, original_short = subprocess.Popen, agent_setup._stream, agent_setup._short
            original_environment = local_base._env_for

            def short(*values, **kwargs):
                value = original_short(*values, **kwargs)
                report.setdefault("versionChecks", []).append(bool(value))
                return value

            def runtime_environment(*values, **kwargs):
                try:
                    result = original_environment(*values, **kwargs)
                    report.setdefault("environmentChecks", []).append(True)
                    return result
                except Exception as exc:
                    report.setdefault("environmentErrors", []).append(type(exc).__name__)
                    raise

            def spawn(*values, **kwargs):
                proc = original_popen(*values, **kwargs)
                processes.append(proc)
                return proc

            def stream(jid, argv, **kwargs):
                env = dict(kwargs["env"])
                assert Path(env["DSH_HOME"]).is_relative_to(temporary), "DSH state escaped disposable probe root"
                assert Path(env["TEMP"]).is_relative_to(temporary), "DSH temp escaped disposable probe root"
                env["NODE_OPTIONS"] = (env.get("NODE_OPTIONS", "") + " --require=" + str(guard)).strip()
                kwargs.update(env=env, timeout=args.timeout)
                result = original_stream(jid, argv, **kwargs)
                observations.append({"exit": result[0], "hostExists": Path(env["DSH_PATH"]).is_dir(),
                    "privateState": True, "missingHost": "could not find a usable DeepSeek Harness runtime" in result[1],
                    "blockedExternalConnection": "E2E_NON_LOOPBACK_CONNECTION_BLOCKED" in result[1],
                    "markerInAgentOutput": marker in result[1]})
                if result[0] and not observations[-1]["missingHost"]:
                    clean = result[1].replace(fixture_key, "<fixture-key>").replace(base, "<loopback>")
                    for original in (str(root), str(adapter.parent.parent), str(runtime)):
                        clean = clean.replace(original, "<isolated-or-installed-path>")
                    report.setdefault("failureOutput", []).append(clean[-6000:])
                return result

            stack.enter_context(patch.object(subprocess, "Popen", spawn))
            stack.enter_context(patch.object(agent_setup, "_stream", stream))
            stack.enter_context(patch.object(agent_setup, "_short", short))
            stack.enter_context(patch.object(local_base, "_env_for", runtime_environment))
            llm = {"base": base, "key": fixture_key, "model": fixture_model, "localOnly": True,
                   "authMode": "api-key", "contextWindow": 32768, "maxOutputTokens": 128}

            def probe():
                jid = agent_setup.start_probe("dsh", llm, private=True)
                deadline = time.monotonic() + args.timeout + 30
                while time.monotonic() < deadline:
                    assert agent_setup.job(jid) is None, "Private job became publicly visible"
                    result = agent_setup.job(jid, include_private=True)
                    if result and result["state"] == "done":
                        assert not result["lines"], "Private probe exposed raw runtime logs"
                        assert fixture_key not in json.dumps(result), "Private result exposed credentials"
                        return result
                    time.sleep(0.1)
                raise TimeoutError("Private DSH probe exceeded bounded deadline")

            original_apply = dsh_runtime.apply_env

            def legacy_apply(env, *values, **kwargs):
                original_apply(env, *values, **kwargs)
                # Reproduce the old coupling of isolated state and installed code.
                env["DSH_PATH"] = str(Path(env["DSH_HOME"]).parent / "agent-runtimes/dsh-host")

            with patch.object(dsh_runtime, "apply_env", legacy_apply):
                before = probe()
            assert before["ok"] is False and observations and observations[-1]["missingHost"], "Legacy runtime-path defect was not reproduced"
            assert not requests, "Legacy failure unexpectedly reached a model"
            report["red"] = {"ok": True, "reason": "Isolated state root incorrectly used as installed DSH root", "exit": observations[-1]["exit"]}
            after = probe()
            assert after["ok"] is True, "Production private DSH execution failed"
            assert requests and not failures, "No valid loopback model request was observed"
            assert observations[-1]["markerInAgentOutput"], "The agent did not return the model response marker"
            assert not observations[-1]["blockedExternalConnection"], "The runtime attempted an external connection"
            assert all(hashlib.sha256(p.read_bytes()).hexdigest() == value for p, value in fingerprints.items()), "Installed package inputs changed"
            report["green"] = {"ok": True, "privateJob": after["private"], "requestCount": len(requests), "installedEntryManifestsUnchanged": True}
            report["ok"] = True
    except Exception as exc:
        report["error"] = str(exc)
    finally:
        for proc in processes:
            if proc.poll() is None:
                from app.services.local_stream import _kill_pid_tree
                _kill_pid_tree(proc.pid, proc)
                try:
                    proc.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    report["ok"] = False
                    report["cleanupError"] = "An owned subprocess did not exit"
        if "agent_setup" in locals():
            for worker in list(agent_setup._JOB_THREADS):
                worker.join(timeout=5)
                if worker.is_alive():
                    report["ok"] = False
                    report["cleanupError"] = "An owned probe worker did not exit"
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        if failures:
            report["providerErrors"] = failures
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--adapter-entry", type=Path, required=True, help="Installed @openma/deepseek-harness-acp/dist/bin.js")
    parser.add_argument("--runtime-root", type=Path, required=True, help="Installed dsh-host directory")
    parser.add_argument("--node", type=Path, required=True, help="Compatible Node executable")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--timeout", type=int, default=90)
    args = parser.parse_args()
    if not 10 <= args.timeout <= 180:
        parser.error("--timeout must be between 10 and 180 seconds")
    args.output = args.output.resolve()
    args.output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="soduwork-dsh-private-e2e-") as directory:
        report = run(args, Path(directory).resolve())
    report["temporaryStateRemoved"] = not Path(directory).exists()
    (args.output / "report.json").write_text(json.dumps(report, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(json.dumps({"ok": report["ok"], "report": str(args.output / "report.json"), "error": report.get("error")}, ensure_ascii=False))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
