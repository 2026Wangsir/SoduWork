"""Loopback origin/proxy regressions; no public download or installation."""
from __future__ import annotations

from contextlib import ExitStack
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import ssl
import tempfile
import threading
from types import SimpleNamespace
import unittest
import urllib.error
import urllib.parse
import urllib.request
from unittest.mock import patch

from app.services import managed_agent_network, managed_agents


class DownloadNetworkTest(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.directory = Path(self.stack.enter_context(tempfile.TemporaryDirectory()))
        self.stack.enter_context(patch.object(urllib.request, "_opener", None))
        self.stack.enter_context(patch.object(os, "environ", {}))
        self.stack.enter_context(patch.object(managed_agents.time, "sleep"))

    def server(self, body=b"origin", status=200, on_request=None, headers=None,
               received_headers=None):
        calls = []
        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                calls.append(self.path)
                if received_headers is not None:
                    received_headers.append(dict(self.headers))
                if on_request:
                    on_request()
                self.send_response(status)
                for key, value in (headers or {}).items():
                    self.send_header(key, value)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            def log_message(self, *_args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=lambda: server.serve_forever(poll_interval=.01),
                                  daemon=True)
        thread.start()
        def close():
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)
        self.addCleanup(close)
        return "http://127.0.0.1:%s" % server.server_port, calls

    def windows(self, registry):
        # The native function is absent on POSIX CI. Patch only its external
        # discovery result; requests still traverse real local HTTP servers.
        # Keep ssl on the real host platform by replacing only this module's sys.
        self.stack.enter_context(patch.object(urllib.request, "getproxies_registry",
                                             side_effect=lambda: dict(registry), create=True))
        self.stack.enter_context(patch.object(managed_agent_network, "sys", SimpleNamespace(platform="win32")))

    def macos(self, settings):
        # Patch discovery only, so the same loopback downloads also run on CI
        # hosts without the macOS SystemConfiguration helper.
        self.stack.enter_context(patch.object(urllib.request, "getproxies_macosx_sysconf",
                                             side_effect=lambda: dict(settings), create=True))
        self.stack.enter_context(patch.object(urllib.request, "proxy_bypass_macosx_sysconf",
                                             return_value=False, create=True))
        self.stack.enter_context(patch.object(managed_agent_network, "sys", SimpleNamespace(platform="darwin")))

    def download(self, url, body, name="archive.zip"):
        target = self.directory / name
        notices = []
        managed_agents._download(url, target, hashlib.sha256(body).hexdigest(), notices.append)
        self.assertEqual(target.read_bytes(), body)
        return notices

    def test_no_proxy_only_keeps_windows_system_proxy_and_explicit_bypass(self):
        origin, direct = self.server()
        proxy, proxied = self.server(body=b"proxy")
        self.windows({"http": proxy})
        os.environ["NO_PROXY"] = "hub.example.invalid"
        self.download(origin + "/asset.zip", b"proxy")
        self.assertEqual(proxied, [origin + "/asset.zip"])
        self.assertEqual(direct, [])
        os.environ["no_proxy"] = "127.0.0.1"
        self.download(origin + "/asset.zip", b"origin", "direct.zip")
        self.assertEqual(direct, ["/asset.zip"])
        self.assertEqual(len(proxied), 1)

    def test_macos_no_proxy_only_keeps_system_proxy_and_explicit_bypass(self):
        origin, direct = self.server()
        proxy, proxied = self.server(body=b"proxy")
        self.macos({"http": proxy})
        os.environ["NO_PROXY"] = "hub.example.invalid"
        self.download(origin + "/asset.zip", b"proxy")
        self.assertEqual(proxied, [origin + "/asset.zip"])
        self.assertEqual(direct, [])
        os.environ["no_proxy"] = "127.0.0.1"
        self.download(origin + "/asset.zip", b"origin", "direct.zip")
        self.assertEqual(direct, ["/asset.zip"])
        self.assertEqual(len(proxied), 1)

    def test_macos_environment_overrides_only_its_protocol_and_preserves_empty_values(self):
        self.macos({"http": "http://system.fixture:80",
                    "https": "http://system.fixture:443"})
        os.environ.update(NO_PROXY="hub.example.invalid", HTTP_PROXY="http://upper.fixture:80",
                          http_proxy="http://lower.fixture:80")
        self.assertEqual(managed_agent_network._proxies(include_macos_system=True), {
            "no": "hub.example.invalid", "http": "http://lower.fixture:80",
            "https": "http://system.fixture:443"})
        os.environ["http_proxy"] = ""
        self.assertNotIn("http", managed_agent_network._proxies(include_macos_system=True))
        self.assertEqual(managed_agent_network._proxies(include_macos_system=True)["https"], "http://system.fixture:443")
        os.environ["HTTPS_PROXY"] = ""
        self.assertNotIn("https", managed_agent_network._proxies(include_macos_system=True))
        os.environ["https_proxy"] = "http://lower.fixture:443"
        self.assertEqual(managed_agent_network._proxies(include_macos_system=True)["https"], "http://lower.fixture:443")
        os.environ["no_proxy"] = ""
        self.assertNotIn("no", managed_agent_network._proxies(include_macos_system=True))

    def test_macos_native_consumers_keep_existing_proxy_discovery(self):
        self.macos({"https": "http://system.fixture:443"})
        os.environ["NO_PROXY"] = "hub.example.invalid"
        with patch.object(urllib.request, "getproxies", return_value={"no": "hub.example.invalid"}) as original:
            self.assertEqual(managed_agent_network._proxies(), {"no": "hub.example.invalid"})
        original.assert_called_once_with()

    def test_macos_system_proxy_keeps_system_exceptions_beside_environment_bypass(self):
        origin, direct = self.server()
        proxy, proxied = self.server(body=b"proxy")
        self.macos({"http": proxy})
        host = urllib.parse.urlsplit(origin).netloc
        cases = ((True, "unrelated.fixture"), (True, ""), (False, "127.0.0.1"))
        for index, (system_bypass, no_proxy) in enumerate(cases):
            with self.subTest(system_bypass=system_bypass, no_proxy=no_proxy):
                # A different protocol's override must not discard this
                # system proxy's exceptions or simple-host bypass policy.
                with (patch.object(os, "environ", {"HTTPS_PROXY": proxy, "NO_PROXY": no_proxy}),
                      patch.object(urllib.request, "proxy_bypass_macosx_sysconf",
                                   side_effect=lambda target: system_bypass and target == host)):
                    self.download(origin + "/asset.zip", b"origin", "system-bypass-%d.zip" % index)
        self.assertEqual(direct, ["/asset.zip"] * len(cases))
        self.assertEqual(proxied, [])

    def test_macos_explicit_scheme_proxy_keeps_environment_bypass_semantics(self):
        origin, direct = self.server()
        system_proxy, system_requests = self.server(body=b"system proxy")
        override, proxied = self.server(body=b"override")
        self.macos({"http": system_proxy})
        with patch.object(urllib.request, "proxy_bypass_macosx_sysconf", return_value=True) as bypass:
            with patch.object(os, "environ", {"http_proxy": override, "NO_PROXY": "unrelated.fixture"}):
                self.download(origin + "/asset.zip", b"override", "explicit-proxy.zip")
            with patch.object(os, "environ", {"http_proxy": override, "NO_PROXY": "127.0.0.1"}):
                self.download(origin + "/asset.zip", b"origin", "explicit-bypass.zip")
            with patch.object(os, "environ", {"http_proxy": "", "NO_PROXY": "unrelated.fixture"}):
                self.download(origin + "/asset.zip", b"origin", "explicit-empty.zip")
            bypass.assert_not_called()
        self.assertEqual(proxied, [origin + "/asset.zip"])
        self.assertEqual(direct, ["/asset.zip", "/asset.zip"])
        self.assertEqual(system_requests, [])

    def test_macos_proxy_changes_are_read_again_between_download_attempts(self):
        origin, direct = self.server()
        good, received = self.server(body=b"proxy")
        settings = {}
        bad, failed = self.server(status=503, on_request=lambda: settings.update(http=good))
        settings["http"] = bad
        self.macos(settings)
        os.environ["NO_PROXY"] = "hub.example.invalid"
        self.download(origin + "/asset.zip", b"proxy")
        self.assertEqual(len(failed), 1)
        self.assertEqual(len(received), 1)
        self.assertEqual(direct, [])

    def test_macos_hub_is_direct_and_its_redirect_uses_the_system_proxy(self):
        origin, direct = self.server(body=b"must use proxy")
        hub, redirected = self.server(status=302, headers={"Location": origin + "/asset.zip"})
        proxy, proxied = self.server(body=b"proxy")
        self.macos({"http": proxy})
        os.environ.update(NO_PROXY="unrelated.fixture", SODUWORK_HUB_HTTP_BASE=hub + "/")
        self.download(hub + "/redirect", b"proxy")
        self.assertEqual(redirected, ["/redirect"])
        self.assertEqual(proxied, [origin + "/asset.zip"])
        self.assertEqual(direct, [])

    def test_macos_missing_hub_asset_falls_back_through_the_system_proxy(self):
        hub, first = self.server(status=404)
        origin, direct = self.server(body=b"must use proxy")
        proxy, proxied = self.server(body=b"archive")
        self.macos({"http": proxy})
        os.environ.update(NO_PROXY="unrelated.fixture", SODUWORK_HUB_HTTP_BASE=hub)
        with (patch.object(managed_agents, "_release_bases", return_value=[hub, origin]),
              patch.object(managed_agents, "_root", return_value=self.directory),
              patch.object(managed_agents, "_cpu_compatibility_issue", return_value=""),
              patch.object(managed_agents, "platform_key", return_value="darwin-arm64"),
              patch.object(managed_agents, "OPENCODE_ARTIFACTS", {
                  "darwin-arm64": ("opencode-darwin-arm64.zip", hashlib.sha256(b"archive").hexdigest())}),
              patch.object(managed_agents, "binary_version", return_value=""),
              patch.object(managed_agents, "_extract_binary", side_effect=RuntimeError("fixture stop"))):
            with self.assertRaisesRegex(RuntimeError, "fixture stop"):
                managed_agents.install("install", lambda _: None)
        self.assertEqual(first, ["/opencode-darwin-arm64.zip"])
        self.assertEqual(proxied, [origin + "/opencode-darwin-arm64.zip"])
        self.assertEqual(direct, [])

    def test_proxy_setting_changes_are_read_again_for_each_attempt(self):
        origin, direct = self.server()
        good, received = self.server(body=b"proxy")
        registry = {}
        bad, failed = self.server(status=503, on_request=lambda: registry.update(http=good))
        registry["http"] = bad
        self.windows(registry)
        os.environ["NO_PROXY"] = "hub.example.invalid"
        self.download(origin + "/asset.zip", b"proxy")
        self.assertEqual(len(failed), 1)
        self.assertEqual(len(received), 1)
        self.assertEqual(direct, [])

    def test_explicit_environment_proxy_and_lowercase_empty_override_registry(self):
        origin, direct = self.server()
        registry_proxy, unused = self.server(body=b"registry")
        selected_proxy, selected = self.server(body=b"selected")
        self.windows({"http": registry_proxy})
        os.environ.update(HTTP_PROXY=registry_proxy, http_proxy=selected_proxy,
                          NO_PROXY="hub.example.invalid")
        self.download(origin + "/selected.zip", b"selected")
        os.environ["http_proxy"] = ""
        self.download(origin + "/direct.zip", b"origin", "direct.zip")
        self.assertEqual(len(selected), 1)
        self.assertEqual(unused, [])
        self.assertEqual(direct, ["/direct.zip"])

    def test_posix_environment_proxy_keeps_normal_behavior(self):
        origin, direct = self.server()
        proxy, proxied = self.server(body=b"proxy")
        self.stack.enter_context(patch.object(managed_agent_network, "sys", SimpleNamespace(platform="linux")))
        os.environ.update(http_proxy=proxy, no_proxy="hub.example.invalid")
        self.download(origin + "/asset.zip", b"proxy")
        self.assertEqual(len(proxied), 1)
        self.assertEqual(direct, [])

    def test_https_settings_merge_per_protocol_and_preserve_empty_overrides(self):
        self.windows({"http": "http://system.fixture:80",
                      "https": "http://system.fixture:443"})
        os.environ.update(NO_PROXY="hub.example.invalid", HTTP_PROXY="http://env.fixture:80")
        self.assertEqual(managed_agent_network._proxies(), {
            "no": "hub.example.invalid", "http": "http://env.fixture:80",
            "https": "http://system.fixture:443"})
        os.environ["HTTPS_PROXY"] = ""
        self.assertNotIn("https", managed_agent_network._proxies())
        os.environ["https_proxy"] = "http://lowercase.fixture:443"
        self.assertEqual(managed_agent_network._proxies()["https"],
                         "http://lowercase.fixture:443")

    def test_missing_hub_asset_is_requested_once_then_next_source_is_used(self):
        for status in (404, 410):
            with self.subTest(status=status):
                missing, first = self.server(status=status)
                ready, second = self.server(body=b"archive")
                os.environ["NO_PROXY"] = "*"
                notices = []
                with (patch.object(managed_agents, "_release_bases", return_value=[missing, ready]),
                      patch.object(managed_agents, "_root", return_value=self.directory),
                      patch.object(managed_agents, "_cpu_compatibility_issue", return_value=""),
                      patch.object(managed_agents, "platform_key", return_value="fixture"),
                      patch.object(managed_agents, "OPENCODE_ARTIFACTS", {
                          "fixture": ("fixture-%s.zip" % status, hashlib.sha256(b"archive").hexdigest())}),
                      patch.object(managed_agents, "binary_version", return_value=""),
                      patch.object(managed_agents, "_extract_binary", side_effect=RuntimeError("fixture stop"))):
                    with self.assertRaisesRegex(RuntimeError, "fixture stop"):
                        managed_agents.install("install", notices.append)
                self.assertEqual(len(first), 1)
                self.assertEqual(len(second), 1)
                self.assertTrue(any("HTTP %s" % status in line for line in notices))
                self.assertFalse(any("准备重试" in line for line in notices))

    def test_configured_hub_is_direct_but_next_source_uses_system_proxy(self):
        hub, first = self.server(status=404)
        origin, direct = self.server(body=b"must use proxy")
        proxy, proxied = self.server(body=b"archive")
        self.windows({"http": proxy})
        os.environ.update(NO_PROXY="unrelated.fixture", SODUWORK_HUB_HTTP_BASE=hub)
        with (patch.object(managed_agents, "_release_bases", return_value=[hub, origin]),
              patch.object(managed_agents, "_root", return_value=self.directory),
              patch.object(managed_agents, "_cpu_compatibility_issue", return_value=""),
              patch.object(managed_agents, "platform_key", return_value="fixture"),
              patch.object(managed_agents, "OPENCODE_ARTIFACTS", {
                  "fixture": ("fixture.zip", hashlib.sha256(b"archive").hexdigest())}),
              patch.object(managed_agents, "binary_version", return_value=""),
              patch.object(managed_agents, "_extract_binary", side_effect=RuntimeError("fixture stop"))):
            with self.assertRaisesRegex(RuntimeError, "fixture stop"):
                managed_agents.install("install", lambda _: None)
        self.assertEqual(first, ["/fixture.zip"])
        self.assertEqual(proxied, [origin + "/fixture.zip"])
        self.assertEqual(direct, [])

    def test_hub_redirect_to_another_origin_restores_proxy_selection(self):
        origin, direct = self.server(body=b"must use proxy")
        hub, redirected = self.server(status=302, headers={"Location": origin + "/asset.zip"})
        proxy, proxied = self.server(body=b"proxy")
        self.windows({"http": proxy})
        os.environ.update(NO_PROXY="unrelated.fixture", SODUWORK_HUB_HTTP_BASE=hub + "/")
        self.download(hub + "/redirect", b"proxy")
        self.assertEqual(redirected, ["/redirect"])
        self.assertEqual(proxied, [origin + "/asset.zip"])
        self.assertEqual(direct, [])

    def test_authenticated_proxy_redirect_cannot_send_credentials_to_direct_targets(self):
        scenarios = ((system, helper, mode)
                     for system, helper in (("win32", "getproxies_registry"),
                                            ("darwin", "getproxies_macosx_sysconf"))
                     for mode in ("hub", "no_proxy"))
        for system, helper, direct_mode in scenarios:
            with self.subTest(system=system, direct_mode=direct_mode):
                target_headers, proxy_headers = [], []
                target, received = self.server(body=b"target", received_headers=target_headers)
                origin, unused = self.server(body=b"must use proxy")
                source = origin.replace("127.0.0.1", "localhost")
                proxy, proxied = self.server(status=302, received_headers=proxy_headers,
                                             headers={"Location": target + "/asset.zip"})
                proxy_parts = urllib.parse.urlsplit(proxy)
                credentials = proxy_parts._replace(
                    netloc="fixture-user:fixture-password@" + proxy_parts.netloc).geturl()
                with (patch.object(urllib.request, helper,
                                   return_value={"http": credentials}, create=True),
                      patch.object(urllib.request, "proxy_bypass_macosx_sysconf", return_value=False, create=True),
                      patch.object(managed_agent_network, "sys", SimpleNamespace(platform=system)),
                      patch.object(os, "environ", {
                          "NO_PROXY": "127.0.0.1" if direct_mode == "no_proxy" else "unrelated.fixture",
                          "SODUWORK_HUB_HTTP_BASE": target if direct_mode == "hub" else "",
                      })):
                    self.download(source + "/redirect", b"target", system + "-" + direct_mode + ".zip")
                self.assertEqual(proxied, [source + "/redirect"])
                self.assertEqual(received, ["/asset.zip"])
                self.assertEqual(unused, [])
                self.assertTrue(any(key.lower() == "proxy-authorization"
                                    for key in proxy_headers[0]))
                self.assertFalse(any(key.lower() == "proxy-authorization"
                                     for key in target_headers[0]))

    def test_last_failure_is_not_advertised_as_another_retry_or_leaks_credentials(self):
        failed, requests = self.server(status=503)
        os.environ["NO_PROXY"] = "*"
        notices = []
        with self.assertRaisesRegex(RuntimeError, "HTTP 503"):
            managed_agents._download(failed + "/asset.zip", self.directory / "fail.zip",
                                     "0" * 64, notices.append)
        self.assertEqual(len(requests), 3)
        self.assertEqual(sum("准备重试" in line for line in notices), 2)
        self.assertIn("HTTP 503", notices[-1])

    def test_source_logs_omit_url_credentials_query_and_fragment(self):
        source = "https://private-user:private-password@mirror.invalid/releases?token=private-token#private-fragment"
        notices = []
        with (patch.object(managed_agents, "_release_bases", return_value=[source, "https://fallback.fixture"]),
              patch.object(managed_agents, "_root", return_value=self.directory),
              patch.object(managed_agents, "_cpu_compatibility_issue", return_value=""),
              patch.object(managed_agents, "platform_key", return_value="windows-x64"),
              patch.object(managed_agents, "binary_version", return_value=""),
              patch.object(managed_agents, "_download", side_effect=RuntimeError("fixture unavailable"))):
            with self.assertRaises(RuntimeError):
                managed_agents.install("install", notices.append)
        self.assertIn("mirror.invalid/releases", "\n".join(notices))
        self.assertNotIn("private-", "\n".join(notices))

    def test_proxy_and_server_errors_cannot_echo_credentials_or_disable_tls(self):
        private = "https://private-user:private-password@proxy.invalid/?token=private-token"
        errors = [
            urllib.error.HTTPError(private, 407, private, {}, None),
            urllib.error.URLError(private),
            urllib.error.URLError(ssl.SSLCertVerificationError(private)),
        ]
        for error in errors:
            with self.subTest(error=type(error).__name__):
                notices = []
                with patch.object(managed_agent_network, "open_download", side_effect=error):
                    with self.assertRaises(RuntimeError) as raised:
                        managed_agents._download("https://origin.fixture/asset.zip",
                            self.directory / "error.zip", "0" * 64, notices.append)
                self.assertNotIn("private-", "\n".join(notices) + str(raised.exception))
                self.assertFalse((self.directory / "error.zip").exists())
        self.assertIn("TLS", str(raised.exception))

    def test_checksum_mismatch_still_rejects_the_download(self):
        origin, requests = self.server(body=b"corrupted")
        os.environ["NO_PROXY"] = "*"
        target = self.directory / "corrupted.zip"
        with self.assertRaisesRegex(RuntimeError, "SHA-256"):
            managed_agents._download(origin + "/asset.zip", target,
                                     hashlib.sha256(b"expected").hexdigest(), lambda _: None)
        self.assertEqual(len(requests), 3)
        self.assertFalse(target.exists())
        self.assertFalse(target.with_suffix(".zip.part").exists())

    def test_network_helper_is_in_the_runner_source_dependency_graph(self):
        from app.services import runner_sources
        backend = Path(__file__).resolve().parent
        inputs = set(runner_sources.build_inputs(backend, backend.parent))
        self.assertIn(backend / "app/services/managed_agent_network.py", inputs)


if __name__ == "__main__":
    unittest.main()
