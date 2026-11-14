"""Real loopback TLS and CONNECT downloads using a temporary private CA."""
from __future__ import annotations

from contextlib import ExitStack
from datetime import datetime, timedelta, timezone
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import ipaddress
import json
import os
from pathlib import Path
import select
import socket
import ssl
import tempfile
import threading
import unittest
from unittest.mock import patch

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from app.services import managed_agent_network as network, managed_agents


def make_certificates(directory):
    now = datetime.now(timezone.utc)
    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca_name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "SoduWork loopback fixture CA")])
    ca = (x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name)
          .public_key(ca_key.public_key()).serial_number(x509.random_serial_number())
          .not_valid_before(now - timedelta(days=1)).not_valid_after(now + timedelta(days=7))
          .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
          .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
          .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
          .sign(ca_key, hashes.SHA256()))
    leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    leaf = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")]))
            .issuer_name(ca_name).public_key(leaf_key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - timedelta(days=1))
            .not_valid_after(now + timedelta(days=7))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(True, False, True, False, False, False, False, False, False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.SubjectAlternativeName([
                x509.DNSName("localhost"), x509.IPAddress(ipaddress.ip_address("127.0.0.1"))]), critical=False)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(leaf_key.public_key()), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    directory.mkdir(parents=True, exist_ok=True)
    ca_path, leaf_path, key_path = (directory / name for name in ("ca.pem", "server.pem", "server-key.pem"))
    ca_path.write_bytes(ca.public_bytes(serialization.Encoding.PEM))
    leaf_path.write_bytes(leaf.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(leaf_key.private_bytes(serialization.Encoding.PEM,
                                              serialization.PrivateFormat.PKCS8,
                                              serialization.NoEncryption()))
    key_path.chmod(0o600)
    return ca_path, leaf_path, key_path


class ManagedAgentTLSTest(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.root = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.ca, leaf, key = make_certificates(self.root / "certificates")
        self.stack.enter_context(patch.dict(os.environ, {
            "SSL_CERT_FILE": str(self.ca), "HTTP_PROXY": "", "HTTPS_PROXY": "",
            "NO_PROXY": "", "no_proxy": ""}, clear=True))
        self.stack.enter_context(patch.object(managed_agents.time, "sleep"))
        self.payload = (b"SoduWork synthetic runtime archive\n" * 70000) + b"complete-tail"
        self.origin_headers = []
        outer = self

        class Origin(BaseHTTPRequestHandler):
            def do_GET(self):
                outer.origin_headers.append(dict(self.headers))
                self.send_response(200)
                self.send_header("Content-Length", str(len(outer.payload)))
                self.end_headers()
                self.wfile.write(outer.payload)

            def log_message(self, *_args):
                pass

        self.origin = ThreadingHTTPServer(("127.0.0.1", 0), Origin)
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(leaf, key)
        self.origin.socket = context.wrap_socket(self.origin.socket, server_side=True)
        self.serve(self.origin)
        self.url = "https://127.0.0.1:%d/archive.zip" % self.origin.server_port

    def serve(self, server):
        # server_close joins request workers after the CONNECT relay is stopped.
        server.daemon_threads = False
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.01), daemon=True)
        thread.start()
        def close():
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
        self.stack.callback(close)

    def proxy(self):
        calls = []
        stopped = threading.Event()
        expected_auth = "Basic " + base64.b64encode(b"fixture-user:fixture-proxy-password").decode("ascii")
        target = ("127.0.0.1", self.origin.server_port)

        class ConnectProxy(BaseHTTPRequestHandler):
            def do_CONNECT(self):
                calls.append({"target": self.path, "authorization": self.headers.get("Proxy-Authorization")})
                if self.headers.get("Proxy-Authorization") != expected_auth:
                    self.send_error(407)
                    return
                if self.path != "%s:%d" % target:
                    self.send_error(403)
                    return
                with socket.create_connection(target, timeout=5) as upstream:
                    self.send_response(200, "Connection Established")
                    self.end_headers()
                    self.wfile.flush()
                    sockets = (self.connection, upstream)
                    while not stopped.is_set():
                        readable, _, _ = select.select(sockets, [], [], .1)
                        for source in readable:
                            data = source.recv(65536)
                            if not data:
                                return
                            destination = upstream if source is self.connection else self.connection
                            destination.sendall(data)

            def log_message(self, *_args):
                pass

        proxy = ThreadingHTTPServer(("127.0.0.1", 0), ConnectProxy)
        self.serve(proxy)
        self.stack.callback(stopped.set)
        address = "http://fixture-user:fixture-proxy-password@127.0.0.1:%d" % proxy.server_port
        return address, calls

    def verified_download(self, *, proxy=None):
        target = self.root / "download.zip"
        routes = []
        original = network.open_download
        def observe(request, **kwargs):
            response = original(request, **kwargs)
            routes.extend(response._soduwork_download_routes)
            return response
        with (patch.dict(os.environ, {"HTTPS_PROXY": proxy or ""}),
              patch.object(network, "open_download", side_effect=observe)):
            managed_agents._download(self.url, target, hashlib.sha256(self.payload).hexdigest(), lambda _: None)
        self.assertEqual(target.read_bytes(), self.payload)
        self.assertEqual(hashlib.sha256(target.read_bytes()).hexdigest(), hashlib.sha256(self.payload).hexdigest())
        self.assertFalse(target.with_suffix(".zip.part").exists())
        return routes

    def test_explicit_ca_allows_a_complete_verified_direct_download(self):
        routes = self.verified_download()
        self.assertEqual(routes, [{"origin": "https://127.0.0.1:%d" % self.origin.server_port,
                                   "route": "direct"}])
        self.assertEqual(len(self.origin_headers), 1)

    def test_real_authenticated_connect_preserves_tls_and_does_not_leak_proxy_credentials(self):
        proxy, calls = self.proxy()
        routes = self.verified_download(proxy=proxy)
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0]["authorization"].startswith("Basic "))
        self.assertEqual(routes, [{"origin": "https://127.0.0.1:%d" % self.origin.server_port,
                                   "route": "proxy"}])
        self.assertEqual(len(self.origin_headers), 1)
        serialized = json.dumps(self.origin_headers).lower()
        self.assertNotIn("proxy-authorization", serialized)
        self.assertNotIn("fixture-user", serialized)
        self.assertNotIn("fixture-proxy-password", serialized)
        self.assertNotIn("fixture-proxy-password", json.dumps(routes))

    def test_unknown_ca_is_rejected_without_publishing_or_repeating_the_request(self):
        unknown_ca, _, _ = make_certificates(self.root / "unrelated-ca")
        target = self.root / "rejected.zip"
        with (patch.dict(os.environ, {"SSL_CERT_FILE": str(unknown_ca)}),
              self.assertLogs("app.services.managed_agents", "WARNING") as logs,
              self.assertRaisesRegex(RuntimeError, "TLS.*证书")):
            managed_agents._download(self.url, target, hashlib.sha256(self.payload).hexdigest(), lambda _: None)
        records = [json.loads(record.getMessage().removeprefix("Agent download failed: "))
                   for record in logs.records if record.getMessage().startswith("Agent download failed: ")]
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0]["category"], "tls_certificate")
        self.assertIs(type(records[0]["verify_code"]), int)
        self.assertEqual(records[0]["stage"], "open_response")
        self.assertEqual(records[0]["received_bytes"], 0)
        self.assertEqual(records[0]["routes"], [{
            "origin": "https://127.0.0.1:%d" % self.origin.server_port, "route": "direct"}])
        self.assertEqual(self.origin_headers, [])
        self.assertFalse(target.exists())
        self.assertFalse(target.with_suffix(".zip.part").exists())


if __name__ == "__main__":
    unittest.main()
