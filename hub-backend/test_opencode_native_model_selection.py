"""Opt-in real OpenCode model changes with isolated history and loopback models."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from app.services import local_base


@unittest.skipUnless(os.environ.get("SODUWORK_TEST_OPENCODE_BIN"), "Requires an explicitly selected installed OpenCode")
class OpenCodeNativeModelSelectionTests(unittest.TestCase):
    def test_native_resume_uses_current_model_and_preserves_history(self):
        self.check_resume(acp=False)

    def test_acp_resume_uses_current_model_and_preserves_history(self):
        self.check_resume(acp=True)

    def check_resume(self, *, acp):
        executable = Path(os.environ["SODUWORK_TEST_OPENCODE_BIN"]).resolve()
        self.assertTrue(executable.is_file())
        calls = []

        class Model(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                calls.append({"model": body.get("model"), "key": self.headers.get("Authorization"),
                              "messages": body.get("messages"), "path": self.path})
                text = "MODEL_SELECTED_" + body["model"]
                chunks = [
                    {"id": "fixture", "object": "chat.completion.chunk", "created": 1,
                     "model": body["model"], "choices": [{"index": 0,
                     "delta": {"role": "assistant", "content": text}, "finish_reason": None}]},
                    {"id": "fixture", "object": "chat.completion.chunk", "created": 1,
                     "model": body["model"], "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
                     "usage": {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2}},
                ]
                payload = ("".join("data: " + json.dumps(chunk) + "\n\n" for chunk in chunks)
                           + "data: [DONE]\n\n").encode()
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Model)
        serving = threading.Thread(target=server.serve_forever,
                                   kwargs={"poll_interval": .01}, daemon=True)
        serving.start()
        try:
            with tempfile.TemporaryDirectory(prefix="soduwork-opencode-model-") as directory:
                root = Path(directory)
                work = root / "中文 workspace"
                work.mkdir()
                allowed = {"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC"}
                clean = {key: value for key, value in os.environ.items() if key.upper() in allowed}
                for key in ("HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME",
                            "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TEMP", "TMP", "TMPDIR"):
                    target = root / key
                    target.mkdir()
                    clean[key] = str(target)
                clean.update({"SODUWORK_DATA_ROOT": str(root / "runner"),
                    "OPENCODE_DB": str(root / "native.db"), "OPENCODE_DISABLE_AUTOUPDATE": "1",
                    "OPENCODE_DISABLE_MODELS_FETCH": "1", "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
                    "OPENCODE_DISABLE_SHARE": "1", "PYTHONUTF8": "1", "PYTHONDONTWRITEBYTECODE": "1"})
                from tests.opencode_native_dependencies import seed
                seed(executable, root / "runner")
                sid = ""
                for index, model in enumerate(("original", "replacement", "replacement")):
                    key = "fixture-key-" + str(index)
                    cfg = {"llm": {"base": f"http://127.0.0.1:{server.server_port}/v1",
                                   "key": key, "model": model, "kind": "openai-compat"}}
                    if acp:
                        cfg["accessPolicy"] = {"mode": "standard"}
                    profile = local_base._PROFILES["opencode"]
                    with patch.dict(os.environ, clean, clear=True):
                        env = local_base._env_for(profile, cfg)
                    registry = json.loads(env["OPENCODE_CONFIG_CONTENT"])["provider"]["company"]["models"]
                    self.assertEqual(list(registry), [model], "Old routes must not be restored or aliased")
                    env.update({"HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9",
                                "ALL_PROXY": "http://127.0.0.1:9", "NO_PROXY": "127.0.0.1,localhost",
                                "no_proxy": "127.0.0.1,localhost"})
                    args = profile["resume" if sid else "start"](sid, "work", str(work), cfg)
                    command = local_base._command_argv(str(executable), args, str(work), cfg, profile)
                    before = len(calls)
                    events = self.run_turn(command, env, work)
                    returned = next((row.get("sessionID") for row in events if row.get("sessionID")), "")
                    self.assertTrue(returned.startswith("ses_"))
                    if sid:
                        self.assertEqual(returned, sid, "Model selection must preserve the original session")
                    sid = returned
                    self.assertTrue(any(row.get("type") == "text" and
                                        row.get("part", {}).get("text") == "MODEL_SELECTED_" + model for row in events))
                    self.assertFalse(any(row.get("error") for row in events))
                    current = calls[before:]
                    self.assertTrue(current)
                    self.assertTrue(all(row["model"] == model and row["key"] == "Bearer " + key and
                                        row["path"] == "/v1/chat/completions" for row in current))
                    if index:
                        self.assertTrue(any("MODEL_SELECTED_original" in json.dumps(row["messages"])
                                            for row in current), "Original assistant history must reach the selected model")
                self.assertTrue((root / "native.db").is_file())
        finally:
            server.shutdown()
            server.server_close()
            serving.join(2)

    def run_turn(self, command, env, work):
        flags = ({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt"
                 else {"start_new_session": True})
        process = subprocess.Popen(command, env=env, cwd=work, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, encoding="utf-8", errors="replace", **flags)
        try:
            stdout, stderr = process.communicate("Reply briefly without using tools.", timeout=40)
        except subprocess.TimeoutExpired:
            from app.services.local_stream import _kill_pid_tree
            _kill_pid_tree(process.pid, process)
            process.communicate(timeout=5)
            self.fail("The isolated native model fixture timed out")
        self.assertEqual(process.returncode, 0, stdout + stderr)
        self.assertNotIn("fixture-key-", stdout + stderr)
        return [json.loads(line) for line in stdout.splitlines() if line.strip()]


if __name__ == "__main__":
    unittest.main()
