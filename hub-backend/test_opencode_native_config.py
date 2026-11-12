"""Opt-in real OpenCode check; all model traffic and native state are fixtures."""
from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch

from app.services import acp_bridge, local_base


@unittest.skipUnless(os.environ.get("SODUWORK_TEST_OPENCODE_BIN"), "Requires an explicitly selected installed OpenCode")
class OpenCodeNativeConfigTests(unittest.TestCase):
    def test_native_start_and_resume_ignore_invalid_personal_config(self):
        self.check_config()

    def test_native_and_acp_ignore_explicit_personal_config_overrides(self):
        for override in ("OPENCODE_CONFIG", "OPENCODE_CONFIG_DIR"):
            for native in (False, True):
                with self.subTest(override=override, native=native):
                    self.check_config(override=override, native=native)

    def check_config(self, *, override="", native=False):
        executable = Path(os.environ["SODUWORK_TEST_OPENCODE_BIN"]).resolve()
        self.assertTrue(executable.is_file())
        calls = []

        class Model(BaseHTTPRequestHandler):
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                calls.append((self.path, body.get("model"), body.get("stream")))
                chunks = [
                    {"id": "fixture", "object": "chat.completion.chunk", "created": 1,
                     "model": "fixture", "choices": [{"index": 0,
                     "delta": {"role": "assistant", "content": "OK"}, "finish_reason": None}]},
                    {"id": "fixture", "object": "chat.completion.chunk", "created": 1,
                     "model": "fixture", "choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}],
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
            with tempfile.TemporaryDirectory(prefix="soduwork-native-opencode-") as directory:
                root = Path(directory)
                work = root / "中文 workspace"
                work.mkdir()
                personal = root / "personal" / "opencode" / "opencode.json"
                personal.parent.mkdir(parents=True)
                original = b"not JSON: PRIVATE-FIXTURE"
                personal.write_bytes(original)
                # Preserve synthetic HOME; never read real auth/database/provider state.
                allowed = {"PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC",
                           "HOME", "USERPROFILE", "APPDATA", "LOCALAPPDATA"}
                clean = {key: value for key, value in os.environ.items() if key.upper() in allowed}
                for key in ("XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TEMP", "TMP"):
                    target = root / key
                    target.mkdir()
                    clean[key] = str(target)
                home = root / "home"
                home.mkdir()
                clean["HOME"] = clean["USERPROFILE"] = str(home)
                clean.update({
                    "SODUWORK_DATA_ROOT": str(root / "runner"),
                    "XDG_CONFIG_HOME": str(personal.parent.parent),
                    "OPENCODE_DB": str(root / "native.db"),
                    "OPENCODE_DISABLE_AUTOUPDATE": "1",
                    "OPENCODE_DISABLE_MODELS_FETCH": "1",
                    "OPENCODE_DISABLE_PROJECT_CONFIG": "1",
                    "PYTHONUTF8": "1",
                    "PYTHONDONTWRITEBYTECODE": "1",
                })
                inherited = ({override: str(personal if override == "OPENCODE_CONFIG" else personal.parent)}
                             if override else {})
                clean.update(inherited)
                cfg = {"llm": {"base": f"http://127.0.0.1:{server.server_port}/v1",
                               "key": "fixture-key", "model": "fixture", "kind": "openai-compat"}}
                with patch.dict(os.environ, clean, clear=True):
                    env = local_base._env_for(local_base._PROFILES["opencode"], cfg)
                for key in ("HOME", "USERPROFILE", "XDG_DATA_HOME", "OPENCODE_DB"):
                    self.assertEqual(env.get(key), clean.get(key), key)
                self.assertEqual(Path(env["XDG_CONFIG_HOME"]), root / "runner" / "agents" / "opencode" / "config")
                env.update({"HTTP_PROXY": "http://127.0.0.1:9", "HTTPS_PROXY": "http://127.0.0.1:9",
                            "NO_PROXY": "127.0.0.1,localhost", "no_proxy": "127.0.0.1,localhost"})
                from tests.opencode_native_dependencies import seed
                seed(executable, root / "runner")
                command = [sys.executable, str(Path(acp_bridge.__file__)), "--cwd", str(work),
                           "--agent-name", "opencode"]
                if native:
                    command = [str(executable), "run", "--format", "json", "--thinking", "--dir", str(work)]
                    suffix = []
                else:
                    suffix = ["--", str(executable), "acp"]
                # Emulate an already-running parent using the old environment.
                old_parent = ({**env, "XDG_CONFIG_HOME": str(personal.parent.parent), **inherited}
                              if not native else env)
                first = self.run_turn([*command, *suffix], old_parent)
                sid = next((row.get("sessionID") for row in first if native or row.get("type") == "session"), "")
                self.assertTrue(sid.startswith("ses_"))
                second = self.run_turn([*command, "--session", sid, *suffix], env)
                self.assertEqual(next((row.get("sessionID") for row in second
                                       if native or row.get("type") == "session"), ""), sid)
                for events in (first, second):
                    self.assertTrue(any(row.get("type") == "text" and
                                        row.get("part", {}).get("text") == "OK" for row in events))
                    self.assertFalse(any(row.get("error") for row in events))
                self.assertEqual(personal.read_bytes(), original)
                self.assertTrue((root / "native.db").is_file())
                self.assertGreaterEqual(len(calls), 2)
                self.assertTrue(all(row == ("/v1/chat/completions", "fixture", True) for row in calls))
        finally:
            server.shutdown()
            server.server_close()
            serving.join(2)

    def run_turn(self, command, env):
        flags = ({"creationflags": subprocess.CREATE_NO_WINDOW} if os.name == "nt"
                 else {"start_new_session": True})
        process = subprocess.Popen(command, env=env, stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   text=True, encoding="utf-8", errors="replace", **flags)
        try:
            stdout, stderr = process.communicate("Reply OK without using tools.", timeout=40)
        except subprocess.TimeoutExpired:
            if os.name == "nt":
                subprocess.run(["taskkill", "/F", "/T", "/PID", str(process.pid)],
                               capture_output=True, timeout=10,
                               creationflags=subprocess.CREATE_NO_WINDOW)
            else:
                from app.services.local_stream import _kill_pid_tree
                _kill_pid_tree(process.pid, process)
            process.communicate(timeout=5)
            self.fail("The local native model fixture timed out")
        self.assertEqual(process.returncode, 0, stdout + stderr)
        self.assertNotIn("PRIVATE-FIXTURE", stdout + stderr)
        self.assertNotIn("fixture-key", stdout + stderr)
        return [json.loads(line) for line in stdout.splitlines() if line.strip()]


if __name__ == "__main__":
    unittest.main()
