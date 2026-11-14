"""Safe installer and gateway diagnostics without external network requests."""
from __future__ import annotations

import hashlib
from email.message import Message
import io
import json
import logging
import os
from pathlib import Path
import socket
import ssl
import tempfile
import unittest
import urllib.error
import urllib.request
import urllib.response
from unittest.mock import Mock, patch

from app.services import local_stream, managed_agent_network as network, managed_agents


PRIVATE = "fixture-private-credential"
PRIVATE_URL = "https://user:" + PRIVATE + "@download.fixture/private-path?token=" + PRIVATE


def certificate_error():
    error = ssl.SSLCertVerificationError(1, PRIVATE)
    error.verify_code = 20
    error.verify_message = PRIVATE
    error.reason = "CERTIFICATE_VERIFY_FAILED"
    return error


class Response:
    def __init__(self, chunks, *, status=200, routes=None):
        self.status = status
        self.headers = {}
        self.chunks = iter(chunks)
        self._soduwork_download_routes = routes or []

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, _size):
        value = next(self.chunks, b"")
        if isinstance(value, Exception):
            raise value
        return value


class SafeNetworkErrorTest(unittest.TestCase):
    def test_tls_subtypes_and_plain_timeouts_remain_distinct(self):
        cases = [
            (certificate_error(), "tls_certificate"),
            (ssl.SSLEOFError(8, PRIVATE), "tls_eof"),
            (ssl.SSLError(1, PRIVATE), "tls_protocol"),
            (socket.gaierror(-2, PRIVATE), "dns"),
            (TimeoutError(PRIVATE), "timeout"),
            (ConnectionRefusedError(61, PRIVATE), "io"),
            (ValueError(PRIVATE), "format"),
            (RuntimeError(PRIVATE), "unknown"),
            (Exception(PRIVATE), "unknown"),
        ]
        for error, category in cases:
            variants = (error,) if isinstance(error, (ValueError, RuntimeError)) else (error, urllib.error.URLError(error))
            for wrapped in variants:
                with self.subTest(category=category, wrapper=type(wrapped).__name__):
                    details = network.error_details(wrapped)
                    self.assertEqual(details["category"], category)
                    self.assertNotIn(PRIVATE, json.dumps(details))
                    self.assertNotIn(PRIVATE, network.error_label(wrapped))
        details = network.error_details(certificate_error())
        self.assertEqual(details["verify_code"], 20)
        self.assertEqual(details["ssl_reason"], "CERTIFICATE_VERIFY_FAILED")
        self.assertIn("证书", network.error_label(certificate_error()))
        self.assertIn("超时", network.error_label(TimeoutError(PRIVATE)))
        self.assertNotEqual(network.error_label(certificate_error()),
                            network.error_label(ssl.SSLEOFError(8, PRIVATE)))

    def test_http_diagnostics_do_not_include_response_headers_or_payload(self):
        error = urllib.error.HTTPError(PRIVATE_URL, 403, PRIVATE,
                                       {"Authorization": PRIVATE}, io.BytesIO(PRIVATE.encode()))
        try:
            details = network.error_details(error)
            self.assertEqual(details["category"], "http")
            self.assertEqual(details["http_status"], 403)
            self.assertNotIn(PRIVATE, json.dumps(details))
            self.assertNotIn(PRIVATE, network.error_label(error))
        finally:
            error.close()

    def test_arbitrary_ssl_fields_cannot_become_log_text(self):
        error = ssl.SSLError(1, PRIVATE)
        error.reason = PRIVATE
        error.library = PRIVATE
        error.verify_code = PRIVATE
        error.winerror = PRIVATE
        details = network.error_details(urllib.error.URLError(error))
        self.assertEqual(details["category"], "tls_protocol")
        self.assertNotIn(PRIVATE, json.dumps(details))
        self.assertNotIn("ssl_reason", details)
        for field in ("errno", "winerror", "verify_code", "http_status"):
            if field in details:
                self.assertIs(type(details[field]), int)


class DownloadRouteDiagnosticTest(unittest.TestCase):
    def open_script(self, url, script, *, proxies=None, hub=""):
        class ScriptedTransport(urllib.request.BaseHandler):
            handler_order = 400

            def http_open(self, request):
                result = script[request.full_url]
                if isinstance(result, Exception):
                    raise result
                status, fields, body = result
                headers = Message()
                for key, value in fields.items():
                    headers[key] = value
                reply = urllib.response.addinfourl(io.BytesIO(body), headers,
                                                  request.full_url, status)
                reply.msg = "Fixture response"
                return reply

            https_open = http_open

        build = urllib.request.build_opener
        def instrumented(*handlers):
            return build(*handlers, ScriptedTransport())
        with (patch.dict(os.environ, {"SODUWORK_HUB_HTTP_BASE": hub}, clear=True),
              patch.object(network, "_proxies", return_value=proxies or {}),
              patch.object(urllib.request, "proxy_bypass", return_value=False),
              patch.object(urllib.request, "proxy_bypass_macosx_sysconf", return_value=False, create=True),
              patch.object(urllib.request, "build_opener", side_effect=instrumented)):
            return network.open_download(urllib.request.Request(url), timeout=5)

    def test_redirect_records_direct_proxy_direct_without_private_url_fields(self):
        start = "https://hub.fixture/start?token=" + PRIVATE
        middle = "https://cdn.fixture/asset?token=" + PRIVATE
        finish = "https://hub.fixture/finish?token=" + PRIVATE
        script = {start: (302, {"Location": middle}, b""),
                  middle: (302, {"Location": finish}, b""),
                  finish: (200, {}, b"archive")}
        with self.open_script(start, script, hub="https://hub.fixture",
                              proxies={"https": "http://proxyuser:" + PRIVATE + "@proxy.fixture:8080"}) as response:
            routes = response._soduwork_download_routes
            self.assertEqual(response.read(), b"archive")
        self.assertEqual(routes, [
            {"origin": "https://hub.fixture:443", "route": "direct"},
            {"origin": "https://cdn.fixture:443", "route": "proxy"},
            {"origin": "https://hub.fixture:443", "route": "direct"}])
        serialized = json.dumps(routes)
        self.assertNotIn(PRIVATE, serialized)
        self.assertNotIn("proxy.fixture", serialized)
        self.assertNotIn("proxyuser", serialized)

    def test_https_connect_failure_retains_the_selected_proxy_route(self):
        url = "https://download.fixture/asset?token=" + PRIVATE
        failure = urllib.error.URLError(certificate_error())
        with self.assertRaises(urllib.error.URLError) as caught:
            self.open_script(url, {url: failure},
                             proxies={"https": "http://proxyuser:" + PRIVATE + "@proxy.fixture:8080"})
        self.assertIs(caught.exception, failure)
        self.assertEqual(caught.exception._soduwork_download_routes,
                         [{"origin": "https://download.fixture:443", "route": "proxy"}])

    def test_direct_failure_never_invents_a_proxy_route(self):
        url = "https://download.fixture/asset"
        with self.assertRaises(urllib.error.URLError) as caught:
            self.open_script(url, {url: urllib.error.URLError(TimeoutError(PRIVATE))})
        self.assertEqual(caught.exception._soduwork_download_routes,
                         [{"origin": "https://download.fixture:443", "route": "direct"}])


class InstallerFailureLogTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.target = Path(self.directory.name) / "archive.zip"
        self.sleep = patch.object(managed_agents.time, "sleep")
        self.sleep.start()
        self.addCleanup(self.sleep.stop)

    def fail_download(self, opener, *, expected=None):
        notices = []
        digest = expected or hashlib.sha256(b"expected archive").hexdigest()
        with (patch.object(network, "open_download", side_effect=opener),
              self.assertLogs("app.services.managed_agents", logging.WARNING) as captured,
              self.assertRaises(RuntimeError)):
            managed_agents._download(PRIVATE_URL, self.target, digest, notices.append)
        records = []
        for record in captured.records:
            message = record.getMessage()
            self.assertNotIn(PRIVATE, message)
            self.assertNotIn("private-path", message)
            if message.startswith("Agent download failed: "):
                records.append(json.loads(message.removeprefix("Agent download failed: ")))
        self.assertTrue(records)
        for record in records:
            self.assertEqual(record["event"], "agent_download_failed")
            self.assertIs(type(record["attempt"]), int)
            self.assertIs(type(record["received_bytes"]), int)
            self.assertIs(type(record["frozen"]), bool)
            self.assertTrue(record["python_version"])
            self.assertTrue(record["tls_version"])
        self.assertNotIn(PRIVATE, "\n".join(notices))
        return records

    def test_certificate_failure_records_safe_fields_without_retrying_the_same_source(self):
        def failed(*_args, **_kwargs):
            error = urllib.error.URLError(certificate_error())
            error._soduwork_download_routes = [
                {"origin": "https://download.fixture:443", "route": "direct"}]
            raise error
        records = self.fail_download(failed)
        self.assertEqual([row["attempt"] for row in records], [1])
        for row in records:
            self.assertEqual(row["stage"], "open_response")
            self.assertEqual(row["received_bytes"], 0)
            self.assertEqual(row["category"], "tls_certificate")
            self.assertEqual(row["verify_code"], 20)
            self.assertEqual(row["routes"], [
                {"origin": "https://download.fixture:443", "route": "direct"}])

    def test_certificate_failure_still_allows_the_next_verified_source(self):
        calls = []
        archive = b"fixture archive"
        def download(request, **_kwargs):
            calls.append(request.full_url)
            if request.full_url.startswith("https://first.fixture/"):
                raise urllib.error.URLError(certificate_error())
            return Response([archive, b""])
        with (patch.object(network, "open_download", side_effect=download),
              patch.object(managed_agents, "_release_bases", return_value=["https://first.fixture", "https://second.fixture"]),
              patch.object(managed_agents, "_root", return_value=Path(self.directory.name)),
              patch.object(managed_agents, "_cpu_compatibility_issue", return_value=""),
              patch.object(managed_agents, "platform_key", return_value="fixture"),
              patch.object(managed_agents, "OPENCODE_ARTIFACTS", {
                  "fixture": ("fixture.zip", hashlib.sha256(archive).hexdigest())}),
              patch.object(managed_agents, "binary_version", return_value=""),
              patch.object(managed_agents, "_extract_binary", side_effect=RuntimeError("fixture extraction boundary")),
              self.assertLogs("app.services.managed_agents", logging.WARNING),
              self.assertRaisesRegex(RuntimeError, "fixture extraction boundary")):
            managed_agents.install("install", lambda _: None)
        self.assertEqual(calls, ["https://first.fixture/fixture.zip", "https://second.fixture/fixture.zip"])

    def test_body_failure_counts_resumed_bytes_and_retains_the_partial(self):
        partial = self.target.with_suffix(".zip.part")
        partial.write_bytes(b"prior")
        def interrupted(request, **_kwargs):
            self.assertTrue(request.get_header("Range"))
            return Response([b"new", ssl.SSLEOFError(8, PRIVATE)], status=206,
                            routes=[{"origin": "https://cdn.fixture:443", "route": "proxy"}])
        records = self.fail_download(interrupted)
        self.assertEqual([row["received_bytes"] for row in records], [8, 11, 14])
        self.assertEqual(partial.read_bytes(), b"priornewnewnew")
        for row in records:
            self.assertEqual(row["stage"], "read_body")
            self.assertEqual(row["category"], "tls_eof")
            self.assertEqual(row["routes"], [
                {"origin": "https://cdn.fixture:443", "route": "proxy"}])

    def test_checksum_failure_is_not_reported_as_tls_or_network(self):
        records = self.fail_download(lambda *_a, **_kw: Response([b"wrong", b""]))
        for row in records:
            self.assertEqual(row["stage"], "checksum")
            self.assertEqual(row["category"], "integrity")
        self.assertFalse(self.target.exists())
        self.assertFalse(self.target.with_suffix(".zip.part").exists())

    def test_publish_failure_preserves_verified_bytes_and_names_the_io_stage(self):
        with patch.object(managed_agents.os, "replace", side_effect=PermissionError(13, PRIVATE)):
            records = self.fail_download(lambda *_a, **_kw: Response([b"archive", b""]),
                                         expected=hashlib.sha256(b"archive").hexdigest())
        for row in records:
            self.assertEqual(row["stage"], "publish")
            self.assertEqual(row["category"], "io")
        self.assertFalse(self.target.exists())
        self.assertEqual(self.target.with_suffix(".zip.part").read_bytes(), b"archive")


class GatewayDiagnosticTest(unittest.TestCase):
    def test_gateway_errors_keep_specific_causes_without_logging_private_model_urls(self):
        url = "https://user:" + PRIVATE + "@local-model.fixture/private-path?token=" + PRIVATE
        for error in (certificate_error(), ssl.SSLEOFError(8, PRIVATE),
                      TimeoutError(PRIVATE), socket.gaierror(-2, PRIVATE)):
            with self.subTest(error=type(error).__name__):
                opener = Mock()
                opener.open.side_effect = urllib.error.URLError(error)
                with (patch.object(urllib.request, "build_opener", return_value=opener),
                      patch.object(local_stream.log, "warning") as warning,
                      patch.object(local_stream.log, "error") as logged_error):
                    message = local_stream._llm_gate_check(
                        {"needs_llm": True}, {"llm": {"base": url}})
                self.assertIn(network.error_label(urllib.error.URLError(error)), message)
                self.assertNotIn(PRIVATE, message)
                self.assertNotIn("private-path", message)
                for logger in (warning, logged_error):
                    self.assertNotIn("local-model.fixture", repr(logger.call_args_list))
                    self.assertNotIn(PRIVATE, repr(logger.call_args_list))

    def test_any_http_response_still_proves_reachability(self):
        for status in (401, 403, 404, 500):
            with self.subTest(status=status):
                opener = Mock()
                opener.open.side_effect = urllib.error.HTTPError(
                    PRIVATE_URL, status, PRIVATE, {}, io.BytesIO())
                with patch.object(urllib.request, "build_opener", return_value=opener):
                    self.assertEqual(local_stream._llm_gate_check(
                        {"needs_llm": True}, {"llm": {"base": "https://gateway.fixture/v1"}}), "")

    def test_account_runtimes_do_not_gain_model_gateway_preflight(self):
        with patch.object(urllib.request, "build_opener") as build:
            self.assertEqual(local_stream._llm_gate_check(
                {"needs_llm": False}, {"llm": {"base": PRIVATE_URL}}), "")
            build.assert_not_called()


if __name__ == "__main__":
    unittest.main()
