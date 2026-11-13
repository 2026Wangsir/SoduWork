"""Exercise the workflow's real curl command against isolated connection faults."""
from __future__ import annotations

from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import shlex
import socket
import struct
import subprocess
import tempfile
import threading
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
KEY_URL = "https://www.postgresql.org/media/keys/ACCC4CF8.asc"
PAYLOAD = b"Synthetic public repository signing key fixture\n"


def download_command(url: str, destination: Path) -> list[str]:
    lines = (ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8").splitlines()
    matches = [line.strip() for line in lines if line.strip().startswith("curl ") and KEY_URL in line]
    if len(matches) != 1:
        raise AssertionError("Expected one official PostgreSQL key download command")
    command = shlex.split(matches[0])
    command[command.index(KEY_URL)] = url
    command[command.index("-o") + 1] = str(destination)
    return command


@contextmanager
def endpoint(actions: list[str]):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_args):
            pass

        def reset_connection(self):
            self.connection.setsockopt(socket.SOL_SOCKET, socket.SO_LINGER, struct.pack("ii", 1, 0))
            self.connection.close()
            self.close_connection = True

        def do_GET(self):
            self.close_connection = True
            with server.request_lock:
                index = server.requests
                server.requests += 1
            action = actions[min(index, len(actions) - 1)]
            if action == "reset":
                self.reset_connection()
                return
            self.send_response(404 if action == "not-found" else 200)
            self.send_header("Content-Length", str(len(PAYLOAD)))
            self.send_header("Connection", "close")
            self.end_headers()
            if action == "partial":
                self.wfile.write(PAYLOAD[:8])
                self.wfile.flush()
                time.sleep(0.02)
                self.reset_connection()
            else:
                self.wfile.write(PAYLOAD)

    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    server.requests = 0
    server.request_lock = threading.Lock()
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}/key.asc", server
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


class PostgresDownloadTests(unittest.TestCase):
    def download(self, actions):
        with tempfile.TemporaryDirectory(prefix="soduwork-pg-download-") as temporary:
            directory = Path(temporary)
            destination = directory / "key.asc"
            # Never consult a user's curl configuration or route loopback through a proxy.
            (directory / ".curlrc").write_text("", encoding="utf-8")
            env = {key: value for key, value in os.environ.items() if not key.lower().endswith("_proxy")}
            env["CURL_HOME"] = str(directory)
            env["XDG_CONFIG_HOME"] = str(directory)
            env["NO_PROXY"] = "127.0.0.1"
            with endpoint(actions) as (url, server):
                result = subprocess.run(download_command(url, destination), env=env,
                                        capture_output=True, timeout=25)
                requests = server.requests
            return result, requests, destination.read_bytes() if destination.exists() else b""

    def test_recovers_after_partial_response_and_connection_reset(self):
        result, requests, data = self.download(["partial", "reset", "success"])
        self.assertEqual(result.returncode, 0, result.stderr.decode(errors="replace"))
        self.assertEqual(requests, 3)
        self.assertEqual(data, PAYLOAD, "Retries must replace partial output, not append to it")

    def test_persistent_connection_resets_fail_after_four_attempts(self):
        result, requests, _data = self.download(["reset"])
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(requests, 4, "One initial attempt and three retries are allowed")

    def test_http_errors_remain_failures_after_bounded_retries(self):
        result, requests, data = self.download(["not-found"])
        self.assertEqual(result.returncode, 22, "curl --fail must reject HTTP error responses")
        self.assertEqual(requests, 4)
        self.assertEqual(data, b"", "An error page must not be installed as a repository key")


if __name__ == "__main__":
    unittest.main()
